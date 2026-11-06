import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, toHex, type Hex } from "viem";
import { Store } from "./store";
import { createServicePayment, reconcileServicePayment, recordServicePaymentSubmission, cancelServicePayment, servicePaymentSummary, type ServicePaymentIntent } from "./service-payments";
import { getBudget, reserveBudget, setBudget, settleReservation } from "./budget";
import { handleRequest } from "./http";

const owner = getAddress(`0x${"1".repeat(40)}`), treasury = getAddress(`0x${"2".repeat(40)}`), other = getAddress(`0x${"3".repeat(40)}`);
const token = getAddress("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"), transactionHash = `0x${"a".repeat(64)}` as Hex, blockHash = `0x${"b".repeat(64)}` as Hex;
let store: Store, tx: Record<string, unknown> | null, receipt: Record<string, unknown> | null, timestamp: number, chain: string, head: string;
beforeEach(() => {
  store = new Store(":memory:"); timestamp = Math.floor(Date.now() / 1000); chain = "0xaa36a7"; head = "0x66"; tx = null; receipt = null;
  vi.stubEnv("ORCUS_SERVICE_PAYMENT_MODE", "testnet"); vi.stubEnv("ORCUS_SERVICE_PAYMENT_TREASURY", treasury);
  vi.stubEnv("SEPOLIA_RPC_URL", "https://sepolia.example/private-rpc-secret");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { method: string; params: unknown[] };
    let result: unknown;
    if (body.method === "eth_chainId") result = chain;
    else if (body.method === "eth_getCode") result = "0x60006000";
    else if (body.method === "eth_call") result = toHex(6n, { size: 32 });
    else if (body.method === "eth_getBlockByNumber") result = { number: body.params[0] === "latest" ? "0x64" : "0x65", hash: blockHash, timestamp: toHex(timestamp) };
    else if (body.method === "eth_blockNumber") result = head;
    else if (body.method === "eth_getTransactionByHash") result = tx;
    else if (body.method === "eth_getTransactionReceipt") result = receipt;
    else throw new Error("Unexpected fixture RPC.");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }));
});
afterEach(() => { store.db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function fixture() {
  const user = store.ensureUser(owner), intent = await createServicePayment(store, user, { amountUsd: "1", requestId: "first-payment" });
  tx = { hash: transactionHash, from: owner, to: token, chainId: chain, value: "0x0", input: intent.data, blockHash, blockNumber: "0x65" };
  receipt = { transactionHash, blockHash, blockNumber: "0x65", status: "0x1", logs: [{ address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: owner, to: treasury } }), data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]), logIndex: "0x0", transactionHash, blockHash, removed: false }] };
  return { user, intent };
}

describe("verified testnet service-credit payments", () => {
  it("defaults disabled, never exposes RPC credentials and cannot mint paid credit by changing the expense cap", async () => {
    const user = store.ensureUser(owner); vi.stubEnv("ORCUS_SERVICE_PAYMENT_MODE", undefined);
    expect(servicePaymentSummary(store, user)).toMatchObject({ mode: "disabled", configured: false, credits: { paidUsd: "0.000000" } });
    await expect(createServicePayment(store, user, { amountUsd: "1", requestId: "disabled" })).rejects.toMatchObject({ code: "SERVICE_PAYMENT_UNCONFIGURED" });
    vi.stubEnv("ORCUS_SERVICE_PAYMENT_MODE", "testnet"); setBudget(store, user.id, "100", "0.1", false);
    expect(() => reserveBudget(store, user.id, "unpaid", "0.01")).toThrow(/credits are too low/);
    expect(JSON.stringify(servicePaymentSummary(store, user))).not.toContain("private-rpc-secret");
  });
  it("quotes immutable exact owner transfers and deduplicates concurrent preparation", async () => {
    const user = store.ensureUser(owner), body = { amountUsd: "1", requestId: "same" };
    const [first, second] = await Promise.all([createServicePayment(store, user, body), createServicePayment(store, user, body)]);
    expect(first.id).toBe(second.id); expect(first).toMatchObject({ mode: "testnet", testOnly: true, token, payer: owner, treasury, amountBaseUnits: "1000000", amountUsd: "1.000000", minimumBlock: "101", value: "0" });
    await expect(createServicePayment(store, user, { ...body, amountUsd: "2" })).rejects.toMatchObject({ code: "SERVICE_PAYMENT_CONFLICT" });
    await expect(createServicePayment(store, user, { amountUsd: "1", requestId: "another" })).rejects.toMatchObject({ code: "SERVICE_PAYMENT_PENDING" });
    expect(servicePaymentSummary(store, user).credits.paidUsd).toBe("0.000000");
  });
  it.each(["", "0", "-1", "0.009999", "100.000001", "999999999999999999999", "1.0000001", "1e3"])("rejects an invalid or out-of-bounds payment amount %s", async amountUsd => {
    const user = store.ensureUser(owner);
    await expect(createServicePayment(store, user, { amountUsd, requestId: "invalid" })).rejects.toBeInstanceOf(Error);
    expect(store.list<ServicePaymentIntent>(user.id, "service-payment")).toHaveLength(0);
  });
  it("credits one confirmed canonical Transfer exactly once under concurrent reconciliation", async () => {
    const h = await fixture(); recordServicePaymentSubmission(store, h.user, h.intent.id);
    recordServicePaymentSubmission(store, h.user, h.intent.id, transactionHash);
    const results = await Promise.all([reconcileServicePayment(store, h.user, h.intent.id), reconcileServicePayment(store, h.user, h.intent.id)]);
    expect(results.map(result => result.status)).toEqual(["credited", "credited"]);
    expect(servicePaymentSummary(store, h.user).credits).toMatchObject({ paidUsd: "1.000000", remainingUsd: "1.000000", refundedUsd: "0.000000" });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='service-payment-proof'").get()).toEqual({ count: 1 });
  });
  it("never credits pending, insufficiently confirmed or reverted transactions", async () => {
    const h = await fixture(), confirmed = receipt;
    receipt = null; await expect(reconcileServicePayment(store, h.user, h.intent.id, transactionHash)).rejects.toMatchObject({ code: "SERVICE_PAYMENT_PENDING" });
    receipt = confirmed; head = "0x65";
    await expect(reconcileServicePayment(store, h.user, h.intent.id, transactionHash)).rejects.toMatchObject({ code: "SERVICE_PAYMENT_PENDING" });
    head = "0x66"; receipt!.status = "0x0";
    expect((await reconcileServicePayment(store, h.user, h.intent.id, transactionHash)).status).toBe("reverted");
    expect(servicePaymentSummary(store, h.user).credits.paidUsd).toBe("0.000000");
  });
  it.each(["owner", "token", "treasury", "amount", "chain", "native-value"])("rejects incorrect %s payment evidence", async field => {
    const h = await fixture();
    if (field === "owner") tx!.from = other;
    if (field === "token") tx!.to = other;
    if (field === "treasury") tx!.input = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [other, 1_000_000n] });
    if (field === "amount") tx!.input = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [treasury, 1_000_001n] });
    if (field === "chain") chain = "0x1";
    if (field === "native-value") tx!.value = "0x1";
    await expect(reconcileServicePayment(store, h.user, h.intent.id, transactionHash)).rejects.toBeInstanceOf(Error);
    expect(servicePaymentSummary(store, h.user).credits.paidUsd).toBe("0.000000");
  });
  it("rejects wrong-user access, reused proof events, stale windows and removed logs", async () => {
    const h = await fixture(), secondUser = store.ensureUser(other);
    await expect(reconcileServicePayment(store, secondUser, h.intent.id, transactionHash)).rejects.toMatchObject({ code: "SERVICE_PAYMENT_NOT_FOUND" });
    const savedTimestamp = timestamp; timestamp = h.intent.notBefore - 1;
    await expect(reconcileServicePayment(store, h.user, h.intent.id, transactionHash)).rejects.toMatchObject({ code: "SERVICE_PAYMENT_WINDOW_INVALID" });
    timestamp = Math.ceil(h.intent.expiresAt / 1000) + 1;
    await expect(reconcileServicePayment(store, h.user, h.intent.id, transactionHash)).rejects.toMatchObject({ code: "SERVICE_PAYMENT_WINDOW_INVALID" });
    timestamp = savedTimestamp; (receipt!.logs as { removed: boolean }[])[0].removed = true;
    await expect(reconcileServicePayment(store, h.user, h.intent.id, transactionHash)).rejects.toMatchObject({ code: "SERVICE_PAYMENT_EVIDENCE_INVALID" });
    (receipt!.logs as { removed: boolean }[])[0].removed = false;
    await reconcileServicePayment(store, h.user, h.intent.id, transactionHash);
    const duplicate = { ...h.intent, id: "other-intent", status: "prepared" as const };
    store.put("service-payment", duplicate);
    await expect(reconcileServicePayment(store, h.user, duplicate.id, transactionHash)).rejects.toMatchObject({ code: "SERVICE_PAYMENT_REPLAY" });
  });
  it("shares paid-credit reservation, spend, release and unknown evidence with the existing capped compute ledger", async () => {
    const h = await fixture(); await reconcileServicePayment(store, h.user, h.intent.id, transactionHash); setBudget(store, h.user.id, "2", "0.1", false);
    expect(reserveBudget(store, h.user.id, "compute", "0.5")).toBe(true);
    expect(reserveBudget(store, h.user.id, "compute", "0.5")).toBe(false);
    expect(servicePaymentSummary(store, h.user).credits).toMatchObject({ reservedUsd: "0.500000", remainingUsd: "0.500000" });
    settleReservation(store, h.user.id, "compute", "unknown");
    expect(servicePaymentSummary(store, h.user).credits.reservedUsd).toBe("0.500000");
    settleReservation(store, h.user.id, "compute", "settled", { requestId: "provider" }, "0.1");
    settleReservation(store, h.user.id, "compute", "settled", { requestId: "provider" }, "0.1");
    reserveBudget(store, h.user.id, "rejected", "0.2"); settleReservation(store, h.user.id, "rejected", "released");
    expect(servicePaymentSummary(store, h.user).credits).toMatchObject({ spentUsd: "0.100000", reservedUsd: "0.000000", remainingUsd: "0.900000", releasedUsd: "0.600000" });
    expect(getBudget(store, h.user.id)).toMatchObject({ spentUsd: "0.100000", reservedUsd: "0.000000" });
    expect(() => reserveBudget(store, h.user.id, "too-much", "1")).toThrow(/credits are too low/);
    setBudget(store, h.user.id, "0.1", "0", false);
    expect(() => reserveBudget(store, h.user.id, "expense-cap", "0.01")).toThrow(/exhausted/);
    expect(servicePaymentSummary(store, h.user).credits.reservedUsd).toBe("0.000000");
  });
  it("retains reservations if billing exceeds the approved amount rather than overdrawing credits", async () => {
    const h = await fixture(); await reconcileServicePayment(store, h.user, h.intent.id, transactionHash); setBudget(store, h.user.id, "1", "0", false);
    reserveBudget(store, h.user.id, "overbill", "0.1"); settleReservation(store, h.user.id, "overbill", "settled", {}, "0.2");
    expect(servicePaymentSummary(store, h.user).credits).toMatchObject({ reservedUsd: "0.100000", spentUsd: "0.000000" });
    expect(getBudget(store, h.user.id).expenses[0].status).toBe("unknown");
  });
  it("preserves credited payment and expense idempotency when the SQLite database is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orcus-service-payments-"));
    store.db.close(); store = new Store(join(directory, "payments.sqlite"));
    try {
      const h = await fixture(); await reconcileServicePayment(store, h.user, h.intent.id, transactionHash); setBudget(store, h.user.id, "1", "0", false); reserveBudget(store, h.user.id, "persisted", "0.1");
      store.db.close(); store = new Store(join(directory, "payments.sqlite"));
      await reconcileServicePayment(store, h.user, h.intent.id, transactionHash); settleReservation(store, h.user.id, "persisted", "settled", {}, "0.02");
      expect(servicePaymentSummary(store, h.user).credits).toMatchObject({ paidUsd: "1.000000", spentUsd: "0.020000", remainingUsd: "0.980000" });
    } finally { store.db.close(); store = new Store(":memory:"); rmSync(directory, { recursive: true, force: true }); }
  });
  it("requires authenticated same-origin intents and refuses arbitrary client credit claims", async () => {
    const h = await fixture(), origin = "http://localhost:3000";
    const challenge = store.createChallenge(h.user.address, origin), session = store.createSession(challenge.id, h.user.address);
    const send = (path: string, body: unknown, authenticated = true) => handleRequest(new Request(`${origin}/api/budget/payments/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(authenticated ? { Cookie: `orcus_session=${session.token}` } : {}) }, body: JSON.stringify(body) }), store);
    expect((await send("intent", { amountUsd: "1", requestId: "auth" }, false)).status).toBe(401);
    expect((await send("reconcile", { intentId: h.intent.id, creditsUsd: "100" })).status).toBe(400);
    expect((await send("reconcile", { intentId: h.intent.id, transactionHash })).status).toBe(200);
    expect((await send("submit", { intentId: h.intent.id, transactionHash })).status).toBe(200);
    expect(() => cancelServicePayment(store, h.user, h.intent.id)).toThrow(/reconciled/);
  });
});
