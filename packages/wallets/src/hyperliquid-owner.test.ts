import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import type { PreparedAction, TradingAccount } from "@orcus/core";
import { approveHyperliquidAgent, executePreparedAction } from "./client";

let wallet: Wallet, owner: string, changedDuringSignature: boolean, signatureError: unknown;
let fetch: ReturnType<typeof vi.fn>, signedTypes: string[];
let account: TradingAccount;

beforeEach(() => {
  wallet = new Wallet(Wallet.createRandom().privateKey); owner = wallet.address; changedDuringSignature = false; signatureError = undefined; signedTypes = [];
  account = { id: "account", userId: "owner", ownerAddress: owner, address: owner, venue: "hyperliquid", chainId: 421614, status: "connected", controlRevision: 0 };
  const ethereum = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [owner];
    if (method === "eth_chainId") return "0x66eee";
    if (method === "eth_signTypedData_v4") {
      if (signatureError) throw signatureError;
      const typed = JSON.parse(params![1] as string); delete typed.types.EIP712Domain;
      signedTypes.push(typed.primaryType);
      const signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
      if (changedDuringSignature) owner = Wallet.createRandom().address;
      return signature;
    }
    throw new Error("Unexpected wallet request");
  } };
  vi.stubGlobal("window", { location: { origin: "http://localhost:3000" }, ethereum });
  fetch = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url === "/api/session") return new Response(JSON.stringify({ data: { user: { address: account.ownerAddress }, accounts: [account] } }));
    return new Response(JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 42, totalSz: "0.01", avgPx: "2000" } }] } } }), { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("Hyperliquid compatible owner signing", () => {
  function preparedOrder(): PreparedAction {
    return { id: "action", account, controlRevision: 0, expiresAt: Date.now() + 20_000, kind: "hyperliquid", request: { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, reduceOnly: false, mode: "manual" }, hyperliquid: { method: "order", params: { orders: [{ a: 4, b: true, p: "2000", s: "0.01", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" } } };
  }
  it("signs the real SDK colon-containing approval type without changing its schema", async () => {
    await approveHyperliquidAgent(Wallet.createRandom().address, "orcus-test");
    expect(signedTypes).toEqual(["HyperliquidTransaction:ApproveAgent"]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(JSON.parse(String(options?.body))).toMatchObject({ action: { type: "approveAgent", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", agentName: "orcus-test" }, signature: { r: expect.any(String), s: expect.any(String), v: expect.any(Number) } });
  });
  it("uses the same compatible signer for owner orders on the shared testnet account", async () => {
    const prepared: PreparedAction = { id: "action", account, controlRevision: 0, expiresAt: Date.now() + 20_000, kind: "hyperliquid", request: { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, reduceOnly: false, mode: "manual" }, hyperliquid: { method: "order", params: { orders: [{ a: 4, b: true, p: "2000", s: "0.01", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" } } };
    await expect(executePreparedAction(prepared)).resolves.toMatchObject({ orderId: "42" });
    expect(signedTypes).toEqual(["Agent"]);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/exchange"))).toHaveLength(1);
    const submission = fetch.mock.calls.find(([url]) => String(url).includes("/exchange"))!;
    expect(JSON.parse(String(submission[1]?.body)).expiresAfter).toBe(prepared.expiresAt);
  });
  it("does not broadcast when the selected owner changes during approval signing", async () => {
    changedDuringSignature = true;
    await expect(approveHyperliquidAgent(Wallet.createRandom().address)).rejects.toThrow();
    expect(signedTypes).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not mark a provider signing failure as a submission", async () => {
    signatureError = { code: -32603, message: "Wallet failed before confirmation" };
    await expect(executePreparedAction(preparedOrder())).rejects.toMatchObject({ code: "SIGNING_FAILED", phase: "not-submitted" });
    expect(fetch.mock.calls.every(([url]) => url === "/api/session")).toBe(true);
  });
  it("does not mark an SDK validation failure before signing as a submission", async () => {
    const prepared = preparedOrder(); prepared.hyperliquid!.params.grouping = "invalid-grouping";
    await expect(executePreparedAction(prepared)).rejects.toMatchObject({ phase: "not-submitted" });
    expect(signedTypes).toEqual([]);
    expect(fetch.mock.calls.every(([url]) => url === "/api/session")).toBe(true);
  });
  it("keeps an explicitly declined signature retryable without recording submission", async () => {
    signatureError = { code: 4001, message: "User rejected request" };
    await expect(executePreparedAction(preparedOrder())).rejects.toMatchObject({ code: "OWNER_REJECTED", phase: "not-submitted" });
    expect(fetch.mock.calls.every(([url]) => url === "/api/session")).toBe(true);
  });
  it("stops when the owner changes after signing without claiming an exchange send", async () => {
    changedDuringSignature = true;
    await expect(executePreparedAction(preparedOrder())).rejects.toMatchObject({ phase: "not-submitted" });
    expect(signedTypes).toEqual(["Agent"]);
    expect(fetch.mock.calls.every(([url]) => url === "/api/session")).toBe(true);
  });
  it("preserves unknown results after the exchange send and never retries", async () => {
    fetch.mockImplementation(async url => {
      if (String(url).includes("/exchange")) throw new Error("Timeout after sending");
      if (url === "/api/session") return new Response(JSON.stringify({ data: { user: { address: account.ownerAddress }, accounts: [account] } }));
      return new Response(JSON.stringify({ data: {} }));
    });
    await expect(executePreparedAction(preparedOrder())).rejects.toMatchObject({ phase: "submitted-unknown" });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/exchange"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url === "/api/actions/submit")).toHaveLength(1);
  });
});
