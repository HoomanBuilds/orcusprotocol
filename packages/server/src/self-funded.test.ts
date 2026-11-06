import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { KernelV3_1AccountAbi } from "@zerodev/sdk";
import { assertNoPaymaster, recordSelfFundedBroadcast, selfFundedSummary, settleSelfFundedReceipt } from "./self-funded";
import { handleRequest } from "./http";
import { Store } from "./store";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), balance: vi.fn(), deposit: vi.fn() }));
vi.mock("@orcus/wallets/kernel", async original => ({ ...await original<typeof import("@orcus/wallets/kernel")>(), createOwnerKernel: mocks.owner }));
const accountAddress = "0x2222222222222222222222222222222222222222";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.balance.mockResolvedValue(1000n); mocks.deposit.mockResolvedValue(0n);
  mocks.owner.mockResolvedValue({ account: { address: accountAddress, getFactoryArgs: async () => ({}) }, publicClient: { getBalance: mocks.balance, readContract: mocks.deposit } });
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("self-funded execution configuration", () => {
  it("requires only the bundler and ignores invalid legacy sponsorship credentials", () => {
    vi.stubEnv("BUNDLER_RPC_URL", "https://public.pimlico.io/v2/11155111/rpc");
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "invalid");
    vi.stubEnv("ORCUS_GAS_SPONSOR_PRIVATE_KEY", "invalid");
    vi.stubEnv("ORCUS_PAYMASTER_ADDRESS", "invalid");
    expect(selfFundedSummary()).toMatchObject({ configured: true, mode: "self-funded", payer: "smart-account" });
    vi.stubEnv("BUNDLER_RPC_URL", "");
    expect(selfFundedSummary().configured).toBe(false);
  });
  it("rejects every sponsor field before forwarding a bundler call", () => {
    for (const field of ["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterAndData"]) expect(() => assertNoPaymaster({ [field]: "0x" })).toThrow(expect.objectContaining({ code: "SPONSORSHIP_DISABLED" }));
    expect(() => assertNoPaymaster({ sender: "0x1111111111111111111111111111111111111111" })).not.toThrow();
  });
  it("returns JSON403 for authenticated sponsored bundler input instead of rejecting the handler promise", async () => {
    const store = new Store(":memory:"), origin = "http://localhost:3000";
    const user = store.ensureUser("0x1111111111111111111111111111111111111111");
    const challenge = store.createChallenge(user.address, origin), session = store.createSession(challenge.id, user.address);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.stubEnv("ORCUS_APP_URL", origin);
    vi.stubEnv("BUNDLER_RPC_URL", "https://bundler.example/rpc");
    try {
      const response = await handleRequest(new Request(`${origin}/api/bundler`, {
        method: "POST", headers: { Origin: origin, Cookie: `orcus_session=${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [{ sender: accountAddress, paymaster: accountAddress }, "0x0000000071727De22E5E9d8BAf0edAc6f37da032"] }),
      }), store);
      expect(response.status).toBe(403);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toMatchObject({ error: { code: "SPONSORSHIP_DISABLED" } });
      expect(fetch).not.toHaveBeenCalled();
    } finally { store.db.close(); }
  });
  it("disables authenticated sponsor endpoints without making any external requests", async () => {
    const store = new Store(":memory:"), origin = "http://localhost:3000";
    const user = store.ensureUser("0x1111111111111111111111111111111111111111");
    const challenge = store.createChallenge(user.address, origin), session = store.createSession(challenge.id, user.address);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.stubEnv("ORCUS_APP_URL", origin);
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "zerodev");
    vi.stubEnv("ZERODEV_PAYMASTER_RPC_URL", "https://rpc.zerodev.app/stale");
    try {
      for (const path of ["paymaster", "gas-sponsorship/reconcile"]) {
        const response = await handleRequest(new Request(`${origin}/api/${path}`, { method: "POST", headers: { Origin: origin, Cookie: `orcus_session=${session.token}` }, body: "{}" }), store);
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ error: { code: "SPONSORSHIP_DISABLED" } });
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { store.db.close(); }
  });
  it("denies a foreign account and a stale action before any RPC access", async () => {
    const h = operationFixture();
    try {
      const foreign = h.store.ensureUser("0x3333333333333333333333333333333333333333");
      await expect(recordSelfFundedBroadcast(h.store, foreign, h.scope, h.operation)).rejects.toMatchObject({ code: "USER_OPERATION_ACCOUNT_MISMATCH" });
      const now = Date.now();
      h.store.put("action", { id: "stale", userId: h.user.id, accountId: "account", status: "awaiting-approval", expiresAt: now - 1, controlRevision: 0, createdAt: now, updatedAt: now });
      await expect(recordSelfFundedBroadcast(h.store, h.user, { actionId: "stale" }, h.operation)).rejects.toMatchObject({ code: "ACTION_STALE" });
      expect(mocks.owner).not.toHaveBeenCalled();
    } finally { h.store.db.close(); }
  });
  it("durably records the hash and nonce before send, blocks replay, and settles the same hash", async () => {
    const h = operationFixture();
    vi.stubEnv("BUNDLER_RPC_URL", "https://bundler.example/rpc");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      const record = await recordSelfFundedBroadcast(h.store, h.user, h.scope, h.operation);
      expect(record).toMatchObject({ status: "pending", sender: accountAddress, nonce: "0x0", maximumGasWei: "120" });
      expect(record.userOperationHash).toMatch(/^0x[\da-f]{64}$/);
      expect(h.store.get(h.user.id, "kernel-operation", record.id)).toMatchObject({ userOperationHash: record.userOperationHash });
      await expect(recordSelfFundedBroadcast(h.store, h.user, h.scope, h.operation)).rejects.toMatchObject({ code: "USER_OPERATION_ALREADY_RECORDED" });
      settleSelfFundedReceipt(h.store, h.user, { userOpHash: record.userOperationHash, sender: accountAddress, actualGasCost: "0x60", receipt: { transactionHash: `0x${"a".repeat(64)}` } });
      expect(h.store.get(h.user.id, "kernel-operation", record.id)).toMatchObject({ status: "settled", actualGasCostWei: "96" });
      expect(fetch).not.toHaveBeenCalled();
    } finally { h.store.db.close(); }
  });
});

function operationFixture() {
  const store = new Store(":memory:"), user = store.ensureUser("0x1111111111111111111111111111111111111111"), now = Date.now();
  store.put("account", { id: "account", userId: user.id, address: accountAddress, smartAccountAddress: accountAddress, ownerAddress: user.address, venue: "uniswap", chainId: 11155111, status: "connected", controlRevision: 0, createdAt: now, updatedAt: now });
  const operation = { sender: accountAddress, nonce: "0x0", callData: encodeFunctionData({ abi: KernelV3_1AccountAbi, functionName: "invalidateNonce", args: [2] }), callGasLimit: "0xa", verificationGasLimit: "0x14", preVerificationGas: "0x1e", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", signature: "0x1234" };
  return { store, user, operation, scope: { accountAddress, purpose: "permission-management" as const } };
}
