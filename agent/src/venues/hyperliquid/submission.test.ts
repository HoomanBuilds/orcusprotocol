import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PreparedAction, TradingAccount } from "@orcus/core";

const mocks = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock("viem/accounts", async importOriginal => {
  const original = await importOriginal<typeof import("viem/accounts")>();
  return { ...original, privateKeyToAccount: (key: `0x${string}`) => {
    const account = original.privateKeyToAccount(key);
    return { ...account, signTypedData: async (parameters: Parameters<typeof account.signTypedData>[0]) => { mocks.sign(); return account.signTypedData(parameters); } };
  } };
});

import { submitHyperliquidAgentAction } from "./index";

let key: `0x${string}`;
let account: TradingAccount;
let prepared: PreparedAction;
let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  key = generatePrivateKey();
  const signer = privateKeyToAccount(key);
  account = { id: "account", userId: "user", venue: "hyperliquid", address: "0x1111111111111111111111111111111111111111", ownerAddress: "0x1111111111111111111111111111111111111111", agentAddress: signer.address, chainId: 421614, status: "authorized", controlRevision: 1 };
  prepared = { id: "action", account, kind: "hyperliquid", request: { accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, reduceOnly: false, mode: "agent" }, controlRevision: 1, expiresAt: Date.now() + 60_000, hyperliquid: { method: "order", params: { orders: [{ a: 4, b: true, p: "2000", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: "0x0123456789abcdef0123456789abcdef" }], grouping: "na" } } };
  fetch = vi.fn(async () => new Response(JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 42 } }] } } }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("guarded Hyperliquid agent submission", () => {
  it("rejects takeover immediately before signing without attempting transport", async () => {
    const assertAuthority = vi.fn(() => { throw new Error("Owner took over"); });
    await expect(submitHyperliquidAgentAction(prepared, account, key, { assertAuthority })).rejects.toMatchObject({ message: "Owner took over", phase: "not-submitted" });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects takeover after signing but before the exact signed payload is sent", async () => {
    const assertAuthority = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Permission revoked"));
    await expect(submitHyperliquidAgentAction(prepared, account, key, { assertAuthority })).rejects.toMatchObject({ message: "Permission revoked", phase: "not-submitted" });
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves SDK signing and sends once after both authority checks", async () => {
    const assertAuthority = vi.fn();
    await expect(submitHyperliquidAgentAction(prepared, account, key, { assertAuthority })).resolves.toMatchObject({ status: "pending", orderId: "42" });
    expect(assertAuthority).toHaveBeenCalledTimes(2);
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ action: { type: "order", orders: prepared.hyperliquid!.params.orders }, expiresAfter: prepared.expiresAt, signature: { v: expect.any(Number), r: expect.any(String), s: expect.any(String) } });
  });
  it("keeps uncertain transport results unknown instead of retrying or rejecting", async () => {
    fetch.mockRejectedValue(new Error("Network timeout"));
    await expect(submitHyperliquidAgentAction(prepared, account, key, { assertAuthority: vi.fn() })).resolves.toMatchObject({ status: "submitted-unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("marks expired or invalid preparation as not submitted", async () => {
    await expect(submitHyperliquidAgentAction({ ...prepared, expiresAt: Date.now() - 1 }, account, key)).rejects.toMatchObject({ code: "STALE_ACTION", phase: "not-submitted" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
