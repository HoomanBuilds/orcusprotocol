import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tradeRequestSchema, type PreparedAction } from "@orcus/core";
import { ApiError } from "./errors";
import { Platform } from "./platform";
import { Store } from "./store";
import * as engine from "./engine";
import type { StoredAccount, StoredAction, StoredPermission } from "./types";

const boundary = vi.hoisted(() => ({ sponsor: vi.fn(), submit: vi.fn() }));
vi.mock("./sponsorship", () => ({ createSessionSponsorship: boundary.sponsor }));
vi.mock("@orcus/wallets/server", () => ({ submitKernelSessionAction: boundary.submit }));
const transactionHash = `0x${"a".repeat(64)}`;
const userOperationHash = `0x${"b".repeat(64)}`;
let directory: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "orcus-sponsored-execution-"));
  vi.stubEnv("ORCUS_DATA_DIR", directory);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
beforeEach(() => { boundary.sponsor.mockReset(); boundary.submit.mockReset(); });
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const store = new Store(":memory:"), user = store.ensureUser(`0x${"1".repeat(40)}`), platform = new Platform(store);
  const connected = platform.createAccount(user, { venue: "uniswap", smartAccountAddress: `0x${"2".repeat(40)}` });
  const account = store.update<StoredAccount>(user.id, "account", connected.id, { status: "authorized" });
  const agent = platform.agent(user), now = Date.now();
  const request = tradeRequestSchema.parse({ accountId: account.id, venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "sell", amount: "0.001", mode: "agent" });
  const prepared: PreparedAction = { id: "sponsored-action", request, account, kind: "user-operation", controlRevision: account.controlRevision, expiresAt: now + 60_000, transactions: [] };
  store.put("permission", { id: "fixture-grant", userId: user.id, accountId: account.id, agentAddress: account.agentAddress!, status: "active", allowedActions: ["swap"], allowedSymbols: ["WETH/USDC"], maxTradeUsd: "100", expiresAt: now + 60_000, enforcement: "account", controlRevision: account.controlRevision, authorization: { fixture: true }, createdAt: now, updatedAt: now } satisfies StoredPermission);
  store.put("action", { id: prepared.id, userId: user.id, accountId: account.id, request, prepared, status: "awaiting-approval", initiator: "agent", controlRevision: account.controlRevision, agentRevision: agent.controlRevision, expiresAt: prepared.expiresAt, createdAt: now, updatedAt: now } satisfies StoredAction);
  vi.spyOn(engine, "callEngine").mockImplementation(async name => {
    if (name === "getMarkets") return [{ venue: "uniswap", symbol: "WETH/USDC", baseAsset: "WETH", quoteAsset: "USDC", midPrice: "2000", observedAt: Date.now() }];
    if (name === "engineConfig") return { uniswap: { usdc: `0x${"3".repeat(40)}` } };
    if (name === "prepareAction") return { ...prepared, id: "fresh-fixture-id" };
    if (name === "reconcileAction") return { status: "confirmed", transactionHash, userOperationHash };
    throw new Error(`Unexpected fixture call: ${name}`);
  });
  return { store, user, platform, prepared };
}

describe("Platform self-funded execution with explicit signer fixtures", () => {
  it("passes the same user's fresh action without ever requesting sponsorship", async () => {
    const h = fixture(), sponsor = { maxOperationGasWei: "1000", getPaymasterData: vi.fn() };
    boundary.sponsor.mockReturnValue(sponsor);
    boundary.submit.mockResolvedValue({ status: "confirmed", transactionHash, userOperationHash });
    try {
      await expect(h.platform.submit(h.user, { actionId: h.prepared.id })).resolves.toMatchObject({ action: { status: "confirmed", userOperationHash } });
      expect(boundary.sponsor).not.toHaveBeenCalled();
      expect(boundary.submit.mock.calls[0][5]).toBeUndefined();
      expect(boundary.submit.mock.calls[0][4]).toBeTypeOf("function");
    } finally { h.store.db.close(); }
  });
  it("records insufficient smart-account gas as not submitted", async () => {
    const h = fixture();
    boundary.submit.mockRejectedValue(Object.assign(new ApiError("SMART_ACCOUNT_GAS_INSUFFICIENT", "Fund the trading account.", 402), { phase: "not-submitted" }));
    try {
      await expect(h.platform.submit(h.user, { actionId: h.prepared.id })).rejects.toMatchObject({ code: "SMART_ACCOUNT_GAS_INSUFFICIENT", phase: "not-submitted" });
      expect(boundary.sponsor).not.toHaveBeenCalled();
      expect(h.store.get<StoredAction>(h.user.id, "action", h.prepared.id)).toMatchObject({ status: "rejected" });
    } finally { h.store.db.close(); }
  });
  it("retains the exact operation hash if a self-funded submission has an unknown outcome", async () => {
    const h = fixture();
    boundary.sponsor.mockReturnValue({ maxOperationGasWei: "1000", getPaymasterData: vi.fn() });
    boundary.submit.mockImplementation(async (_prepared, _key, _grant, onSubmitted) => {
      await onSubmitted({ userOperationHash });
      throw Object.assign(new Error("Uncertain submission."), { phase: "submitted-unknown", evidence: { userOperationHash } });
    });
    try {
      await expect(h.platform.submit(h.user, { actionId: h.prepared.id })).rejects.toMatchObject({ phase: "submitted-unknown" });
      expect(h.store.get<StoredAction>(h.user.id, "action", h.prepared.id)).toMatchObject({ status: "submitted-unknown", userOperationHash });
    } finally { h.store.db.close(); }
  });
});
