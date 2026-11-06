import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCallDataEpV07, KernelV3_1AccountAbi } from "@zerodev/sdk";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import type { PreparedAction } from "@orcus/core";
import { entryPoint } from "@orcus/wallets/kernel";
import { createSessionSponsorship, listGasSponsorship, noteSponsoredBroadcast, settleSponsoredReceipt, sponsorKernelOperation, sponsorshipSummary, validateSponsoredBroadcast } from "./sponsorship";
import { Store } from "./store";
import type { StoredAccount } from "./types";
import { handleRequest } from "./http";

const mocks = vi.hoisted(() => ({ address: `0x${"1".repeat(40)}`, factory: undefined as string | undefined, factoryData: undefined as string | undefined, operator: vi.fn() }));
vi.mock("@orcus/wallets/kernel", async original => ({ ...await original<typeof import("@orcus/wallets/kernel")>(), createOwnerKernel: async () => ({ account: { address: mocks.address, getFactoryArgs: async () => ({ factory: mocks.factory, factoryData: mocks.factoryData }) } }) }));
vi.mock("./operator-sponsor", () => ({ sponsorWithOperator: mocks.operator }));
const abi = parseAbi(["function approve(address spender,uint256 amount) returns(bool)", "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns(uint256)", "function multicall(uint256 deadline,bytes[] data) returns(bytes[])"]);
const tokenIn = `0x${"3".repeat(40)}` as Hex, tokenOut = `0x${"4".repeat(40)}` as Hex, router = `0x${"5".repeat(40)}` as Hex, paymaster = `0x${"6".repeat(40)}`;
const responseData = () => ({ paymaster, paymasterData: "0x1234", callGasLimit: "0x64", verificationGasLimit: "0x64", preVerificationGas: "0x64", paymasterVerificationGasLimit: "0x64", paymasterPostOpGasLimit: "0x64", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" });
let store: Store;
beforeEach(() => {
  store = new Store(":memory:"); mocks.factory = undefined; mocks.factoryData = undefined;
  mocks.operator.mockReset(); mocks.operator.mockImplementation(async () => ({ result: responseData(), depositWei: 1500n, paymaster, validUntil: Math.floor(Date.now() / 1000) + 120 }));
  vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "zerodev");
  vi.stubEnv("ZERODEV_RPC_URL", "https://rpc.zerodev.app/api/test-bundler-secret"); vi.stubEnv("ZERODEV_PAYMASTER_RPC_URL", "https://rpc.zerodev.app/api/test-paymaster-secret");
  vi.stubEnv("ZERODEV_SPONSOR_USER_DAILY_ETH", "0.02"); vi.stubEnv("ZERODEV_SPONSOR_PROJECT_DAILY_ETH", "0.2"); vi.stubEnv("ZERODEV_SPONSOR_MAX_OPERATION_ETH", "0.003"); vi.stubEnv("ZERODEV_SPONSOR_USER_DAILY_OPERATIONS", "20");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: responseData() }))));
});
afterEach(() => { store.db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture(ownerDigit = "2", nonce = "0x0") {
  const user = store.ensureUser(`0x${ownerDigit.repeat(40)}`), now = Date.now(), account = { id: `account-${user.id}`, userId: user.id, venue: "uniswap", chainId: 11155111, address: mocks.address, smartAccountAddress: mocks.address, ownerAddress: user.address, status: "connected", controlRevision: 0, label: "Test", createdAt: now, updatedAt: now };
  store.put("account", account);
  const request = { accountId: account.id, venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "sell", amount: "10", mode: "manual", slippageBps: 50, tokenIn, tokenOut, tokenInDecimals: 0, tokenOutDecimals: 0, feeTier: 500 };
  const inner = encodeFunctionData({ abi, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut, fee: 500, recipient: mocks.address as Hex, amountIn: 10n, amountOutMinimum: 9n, sqrtPriceLimitX96: 0n }] });
  const transactions = [{ to: tokenIn, data: encodeFunctionData({ abi, functionName: "approve", args: [router, 10n] }), value: "0", chainId: 11155111 }, { to: router, data: encodeFunctionData({ abi, functionName: "multicall", args: [BigInt(Math.floor((now + 30_000) / 1000)), [inner]] }), value: "0", chainId: 11155111 }];
  const prepared = { id: `action-${user.id}`, kind: "uniswap", account, request, controlRevision: 0, expiresAt: now + 60_000, transactions, quote: { minimumOut: "9" } } as unknown as PreparedAction;
  store.put("action", { id: prepared.id, userId: user.id, accountId: account.id, request, prepared, status: "awaiting-approval", controlRevision: 0, agentRevision: 0, expiresAt: prepared.expiresAt, createdAt: now, updatedAt: now });
  const operation = { sender: mocks.address, nonce, callData: await encodeCallDataEpV07(transactions.map(tx => ({ to: tx.to, data: tx.data, value: 0n }))), maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", signature: "0x1234" };
  const input = { chainId: 11155111, entryPointAddress: entryPoint.address, userOp: operation, shouldOverrideFee: false, shouldConsume: true };
  return { user, account, prepared, operation, input, scope: { actionId: prepared.id } };
}
function selectOperator() {
  vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "operator"); vi.stubEnv("BUNDLER_RPC_URL", "https://bundler.example/private-bundler");
  vi.stubEnv("ORCUS_PAYMASTER_ADDRESS", paymaster); vi.stubEnv("ORCUS_GAS_SPONSOR_PRIVATE_KEY", `0x${"11".repeat(32)}`);
}

describe("scoped Kernel sponsorship", () => {
  it("requires an authenticated owner and never exposes provider URLs in public configuration", async () => {
    const request = new Request("http://localhost:3000/api/paymaster", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "orcus_sponsorUserOperation", params: [] }) });
    expect((await handleRequest(request, store)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    const config = await handleRequest(new Request("http://localhost:3000/api/wallet-config"), store);
    const text = await config.text();
    expect(text).toContain('"mode":"self-funded"');
    expect(text).not.toContain("test-paymaster-secret");
    expect(text).not.toContain("test-bundler-secret");
  });
  it("rejects the retired authenticated sponsorship endpoint", async () => {
    const h = await fixture(), origin = "http://localhost:3000";
    const challenge = store.createChallenge(h.user.address, origin), session = store.createSession(challenge.id, h.user.address);
    const send = (method: string, actionId = h.prepared.id, extraHeaders: Record<string, string> = {}) => handleRequest(new Request(`${origin}/api/paymaster?actionId=${actionId}`, { method: "POST", headers: { Origin: origin, Cookie: `orcus_session=${session.token}`, "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [h.input] }) }), store);
    expect((await send("eth_sendTransaction")).status).toBe(410);
    expect((await send("orcus_sponsorUserOperation", "not-this-users-action")).status).toBe(410);
    expect((await send("orcus_sponsorUserOperation", h.prepared.id, { Origin: "https://different-origin.invalid" })).status).toBe(403);
    const response = await send("orcus_sponsorUserOperation");
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "SPONSORSHIP_DISABLED" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("only reports configuration and never exposes provider credentials", () => {
    expect(sponsorshipSummary()).toMatchObject({ configured: true, required: true, chainId: 11155111 });
    expect(JSON.stringify(sponsorshipSummary())).not.toContain("secret");
    vi.stubEnv("ZERODEV_PAYMASTER_RPC_URL", ""); expect(sponsorshipSummary().configured).toBe(false);
  });
  it("binds the approval to exact reviewed calls, owner factory, entrypoint and fresh revision", async () => {
    const h = await fixture();
    await expect(sponsorKernelOperation(store, h.user, h.scope, { ...h.input, entryPointAddress: tokenIn })).rejects.toMatchObject({ code: "SPONSORSHIP_ENTRYPOINT_MISMATCH" });
    await expect(sponsorKernelOperation(store, h.user, h.scope, { ...h.input, userOp: { ...h.operation, callData: "0x1234" } })).rejects.toMatchObject({ code: "SPONSORSHIP_CALL_MISMATCH" });
    mocks.factory = tokenIn; mocks.factoryData = "0x1234";
    await expect(sponsorKernelOperation(store, h.user, h.scope, h.input)).rejects.toMatchObject({ code: "SPONSORSHIP_FACTORY_MISMATCH" });
    mocks.factory = undefined; mocks.factoryData = undefined;
    await sponsorKernelOperation(store, h.user, h.scope, h.input);
    store.update<StoredAccount>(h.user.id, "account", h.account.id, { controlRevision: 1 });
    await expect(validateSponsoredBroadcast(store, h.user, { ...h.operation, ...responseData() })).rejects.toMatchObject({ code: "SPONSORSHIP_ACTION_STALE" });
  });
  it("validates final returned gas and rejects missing or excessive paymaster data", async () => {
    const h = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: { ...responseData(), maxFeePerGas: "0xffffffffffffffff" } }))));
    await expect(sponsorKernelOperation(store, h.user, h.scope, h.input)).rejects.toMatchObject({ code: "SPONSORSHIP_REJECTED" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "test-paymaster-secret" } }))));
    await expect(sponsorKernelOperation(store, h.user, h.scope, h.input)).rejects.toThrow(/no valid bounded approval/);
    expect(listGasSponsorship(store, h.user)).toHaveLength(0);
  });
  it("accepts uint256 Kernel nonces and does not consume policy quota for estimation", async () => {
    const h = await fixture("2", `0x${(2n ** 248n).toString(16)}`);
    const result = await sponsorKernelOperation(store, h.user, h.scope, { ...h.input, shouldConsume: false });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).params[0].shouldConsume).toBe(false);
    await expect(validateSponsoredBroadcast(store, h.user, { ...h.operation, ...result })).rejects.toMatchObject({ code: "SPONSORSHIP_GRANT_MISMATCH" });
    await sponsorKernelOperation(store, h.user, h.scope, h.input);
    await expect(validateSponsoredBroadcast(store, h.user, { ...h.operation, ...result })).resolves.toMatchObject({ stage: "final" });
  });
  it("never shrinks an older issued approval reservation after a cheaper reissue", async () => {
    const h = await fixture(); await sponsorKernelOperation(store, h.user, h.scope, h.input);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: { ...responseData(), maxFeePerGas: "0x1" } }))));
    await sponsorKernelOperation(store, h.user, h.scope, h.input);
    expect(listGasSponsorship(store, h.user)[0].reserveWei).toBe("1000");
  });
  it("enforces per-user and shared-project caps atomically across tenants", async () => {
    const first = await fixture("2"); await sponsorKernelOperation(store, first.user, first.scope, first.input);
    vi.stubEnv("ZERODEV_SPONSOR_PROJECT_DAILY_ETH", "0.000000000000001999");
    const second = await fixture("7");
    await expect(sponsorKernelOperation(store, second.user, second.scope, second.input)).rejects.toMatchObject({ code: "SPONSORSHIP_PROJECT_CAP" });
    vi.stubEnv("ZERODEV_SPONSOR_PROJECT_DAILY_ETH", "0.2"); vi.stubEnv("ZERODEV_SPONSOR_USER_DAILY_ETH", "0.000000000000001999");
    await expect(sponsorKernelOperation(store, first.user, first.scope, { ...first.input, userOp: { ...first.operation, nonce: "0x1" } })).rejects.toMatchObject({ code: "SPONSORSHIP_USER_CAP" });
  });
  it("keeps old unresolved approvals reserved across UTC midnight", async () => {
    const h = await fixture(); await sponsorKernelOperation(store, h.user, h.scope, h.input);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 86_400_000);
    const next = await fixture("2", "0x1"); vi.stubEnv("ZERODEV_SPONSOR_USER_DAILY_ETH", "0.000000000000001999");
    await expect(sponsorKernelOperation(store, next.user, next.scope, next.input)).rejects.toMatchObject({ code: "SPONSORSHIP_USER_CAP" });
    expect(listGasSponsorship(store, h.user)[0].status).toBe("reserved");
  });
  it("settles bigint receipts once and does not move past charges into a later UTC day", async () => {
    const h = await fixture(); const result = await sponsorKernelOperation(store, h.user, h.scope, h.input), hash = `0x${"a".repeat(64)}`;
    await noteSponsoredBroadcast(store, h.user, { ...h.operation, ...result }, hash);
    settleSponsoredReceipt(store, h.user, { userOpHash: hash, sender: h.operation.sender, actualGasCost: 400n });
    expect(listGasSponsorship(store, h.user)[0]).toMatchObject({ status: "settled", actualGasCostWei: "400" });
    const before = store.list<{ updatedAt: number }>(h.user.id, "gas-sponsorship")[0].updatedAt;
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 86_400_000); settleSponsoredReceipt(store, h.user, { userOpHash: hash, sender: h.operation.sender, actualGasCost: 400n });
    expect(store.list<{ updatedAt: number }>(h.user.id, "gas-sponsorship")[0].updatedAt).toBe(before);
  });
  it("only sponsors bounded owner permission recovery, not arbitrary self execution", async () => {
    const h = await fixture(), scope = { accountAddress: h.account.address, purpose: "permission-management" };
    const callData = encodeFunctionData({ abi: KernelV3_1AccountAbi, functionName: "invalidateNonce", args: [2] });
    await expect(sponsorKernelOperation(store, h.user, scope, { ...h.input, userOp: { ...h.operation, callData } })).resolves.toMatchObject({ paymaster });
    const wrong = encodeFunctionData({ abi: KernelV3_1AccountAbi, functionName: "uninstallValidation", args: [`0x01${"0".repeat(40)}`, "0x", "0x"] });
    await expect(sponsorKernelOperation(store, h.user, scope, { ...h.input, userOp: { ...h.operation, callData: wrong } })).rejects.toMatchObject({ code: "SPONSORSHIP_CALL_MISMATCH" });
  });
  it("returns a not-submitted phase if the local session sponsor is unconfigured", async () => {
    const h = await fixture(); vi.stubEnv("ZERODEV_PAYMASTER_RPC_URL", "");
    expect(() => createSessionSponsorship(store, h.user, h.prepared)).toThrow(/Nothing was submitted/);
    try { createSessionSponsorship(store, h.user, h.prepared); } catch (error) { expect(error).toMatchObject({ phase: "not-submitted" }); }
  });
  it("defaults to operator without treating a configured secondary as a ready primary", async () => {
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", undefined); vi.stubEnv("BUNDLER_RPC_URL", "");
    expect(sponsorshipSummary()).toMatchObject({ provider: "operator", configured: false });
    const h = await fixture();
    await expect(sponsorKernelOperation(store, h.user, h.scope, h.input)).rejects.toMatchObject({ code: "SPONSORSHIP_UNCONFIGURED" });
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.operator).not.toHaveBeenCalled();
  });
  it("does not invoke an operator even if stale signing configuration remains", async () => {
    selectOperator(); const h = await fixture(), origin = "http://localhost:3000";
    const challenge = store.createChallenge(h.user.address, origin), session = store.createSession(challenge.id, h.user.address);
    const response = await handleRequest(new Request(`${origin}/api/paymaster?actionId=${h.prepared.id}`, { method: "POST", headers: { Origin: origin, Cookie: `orcus_session=${session.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "orcus_sponsorUserOperation", params: [h.input] }) }), store);
    expect(response.status).toBe(410); expect(await response.json()).toMatchObject({ error: { code: "SPONSORSHIP_DISABLED" } });
    expect(mocks.operator).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(listGasSponsorship(store, h.user)).toEqual([]);
    expect(JSON.stringify(listGasSponsorship(store, h.user))).not.toContain("paymasterData");
    expect(JSON.stringify(sponsorshipSummary())).not.toContain("private-bundler");
  });
  it("atomically reserves the actual operator deposit against unresolved approvals across users", async () => {
    selectOperator(); const first = await fixture("2"); await sponsorKernelOperation(store, first.user, first.scope, first.input);
    const second = await fixture("7");
    await expect(sponsorKernelOperation(store, second.user, second.scope, second.input)).rejects.toMatchObject({ code: "SPONSORSHIP_UNFUNDED" });
    expect(listGasSponsorship(store, second.user)).toHaveLength(0);
    expect(listGasSponsorship(store, first.user)[0].reserveWei).toBe("1000");
  });
  it("binds a grant to its provider and paymaster instead of switching an operation mid-flight", async () => {
    const h = await fixture(), approval = await sponsorKernelOperation(store, h.user, h.scope, h.input);
    selectOperator();
    await expect(validateSponsoredBroadcast(store, h.user, { ...h.operation, ...approval })).rejects.toMatchObject({ code: "SPONSORSHIP_PROVIDER_CHANGED" });
    await expect(sponsorKernelOperation(store, h.user, h.scope, h.input)).rejects.toMatchObject({ code: "SPONSORSHIP_PROVIDER_CHANGED" });
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "zerodev");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: { ...responseData(), paymaster: tokenIn } }))));
    await expect(sponsorKernelOperation(store, h.user, h.scope, h.input)).rejects.toMatchObject({ code: "SPONSORSHIP_PROVIDER_CHANGED" });
    expect(listGasSponsorship(store, h.user)[0]).toMatchObject({ provider: "zerodev", paymaster });
  });
});
