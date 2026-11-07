import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OstiumAllowanceIntent, TradingAccount } from "@orcus/core";
import type { Workspace } from "../../lib/use-workspace";
import { OstiumAccountCard, nativeJournalKey, ostiumPermissionRequest, readNativeAccessJournal } from "./ostium-account-card";
import { OstiumAllowanceControls, ostiumAllowanceCanSign, ostiumAllowanceStateLabel, validOstiumAllowanceAmount } from "./ostium-allowance-controls";

vi.mock("../../lib/wallets", () => ({ approveOstiumAllowance: vi.fn(), grantOstiumPermission: vi.fn(), revokeOstiumPermission: vi.fn() }));
vi.mock("../trading/primitives", () => ({ Address: ({ value }: { value?: string }) => <span>{value ?? "Unavailable"}</span>, Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>, Field: ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => <label>{label}{children}{hint && <small>{hint}</small>}</label>, InlineError: ({ message }: { message?: string }) => message ?? null, Spinner: () => "Loading", Status: ({ value }: { value: string }) => <span>{value}</span> }));
const owner = `0x${"1".repeat(40)}`, agent = `0x${"2".repeat(40)}`;
const account: TradingAccount = { id: "native-account", userId: "user", venue: "ostium", address: owner, ownerAddress: owner, chainId: 421614, agentAddress: agent, status: "connected", controlRevision: 0 };
const draft = { maxTradeUsd: "100", maxCollateralUsd: "25", maxLeverage: "3.25", hours: "24", symbols: "XAU/USD, WTI/USD", actions: ["market", "close"] as Array<"market" | "close"> };
afterEach(() => vi.unstubAllGlobals());

describe("bounded native access review", () => {
  it("preserves separate collateral/notional units, exact symbols, lifetime and fractional leverage", () => {
    expect(ostiumPermissionRequest(account, draft, 1000)).toEqual({ accountId: account.id, action: "prepare", maxTradeUsd: "100", maxCollateralUsd: "25", maxLeverage: 3.25, allowedSymbols: ["XAU/USD", "WTI/USD"], allowedActions: ["market", "close"], expiresAt: 86_401_000 });
  });
  it.each([{ symbols: "" }, { symbols: "XAU/USD,XAU/USD" }, { symbols: "XAU" }, { maxTradeUsd: "0" }, { maxCollateralUsd: "-1" }, { maxTradeUsd: "1e4" }, { maxCollateralUsd: "1.0000001" }, { maxLeverage: "3.251" }, { maxLeverage: "1001" }, { hours: "721" }, { actions: ["remove-collateral"] as never }, { actions: [] }])("rejects invalid or broader access %j", change => {
    expect(() => ostiumPermissionRequest(account, { ...draft, ...change })).toThrow();
  });
  it("rejects another venue or account and keeps recovery namespaced by owner/account", () => {
    expect(() => ostiumPermissionRequest({ ...account, venue: "hyperliquid" }, draft)).toThrow();
    expect(() => ostiumPermissionRequest({ ...account, chainId: 1 }, draft)).toThrow();
    expect(() => ostiumPermissionRequest({ ...account, address: agent }, draft)).toThrow();
    expect(nativeJournalKey(account)).not.toBe(nativeJournalKey({ ...account, id: "another" }));
    expect(nativeJournalKey(account)).not.toBe(nativeJournalKey({ ...account, ownerAddress: agent }));
  });
  it("retains unresolved native journals and refuses malformed or foreign recovery records", () => {
    const journal = { version: 1, purpose: "grant", status: "started", account, plan: { chainId: 421614, delegate: agent, expiresAt: 1, transactions: [] }, permission: { id: "grant", agentAddress: agent, expiresAt: 1, maxTradeUsd: "100", maxCollateralUsd: "25", maxLeverage: 3, allowedSymbols: ["XAU/USD"], allowedActions: ["market"] } };
    expect(readNativeAccessJournal(JSON.stringify(journal), account)?.status).toBe("started");
    expect(readNativeAccessJournal(null, account)).toBeNull();
    expect(() => readNativeAccessJournal("not JSON", account)).toThrow();
    expect(() => readNativeAccessJournal(JSON.stringify(journal), { ...account, ownerAddress: agent })).toThrow();
    expect(() => readNativeAccessJournal(JSON.stringify({ ...journal, permission: {} }), account)).toThrow();
  });
});

describe("exact native USDC allowances", () => {
  it.each(["0", "-1", "1e4", "01", "1.0000001", "2000000.000001", "", " "])("rejects unsupported approval amount %j", amount => expect(validOstiumAllowanceAmount(amount)).toBe(false));
  it.each(["0.000001", "1", "25.123456", "2000000"])("accepts exact bounded USDC amount %j", amount => expect(validOstiumAllowanceAmount(amount)).toBe(true));
  it("requires an explicit fresh review and never enables a started or foreign allowance", () => {
    const intent = { id: "approval", status: "prepared", accountId: account.id, trader: owner, chainId: 421614, expiresAt: 2000 } as OstiumAllowanceIntent;
    expect(ostiumAllowanceCanSign(intent, account, true, 1000)).toBe(true);
    expect(ostiumAllowanceCanSign(intent, account, false, 1000)).toBe(false);
    expect(ostiumAllowanceCanSign(intent, account, true, 2000)).toBe(false);
    for (const status of ["submitting", "pending", "submitted-unknown", "confirmed", "rejected", "cancelled"] as const) expect(ostiumAllowanceCanSign({ ...intent, status }, account, true, 1000)).toBe(false);
    expect(ostiumAllowanceCanSign({ ...intent, transactionHash: `0x${"a".repeat(64)}` }, account, true, 1000)).toBe(false);
    expect(ostiumAllowanceCanSign({ ...intent, trader: agent }, account, true, 1000)).toBe(false);
    expect(ostiumAllowanceCanSign({ ...intent, accountId: "foreign" }, account, true, 1000)).toBe(false);
  });
  it("renders real account roles and gas boundaries without fetching or signing", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const workspace = { session: { user: { id: "user", address: owner } }, venue: "ostium", symbol: "XAU/USD", agentData: null, portfolio: { balances: [] }, refresh: vi.fn() } as unknown as Workspace;
    const markup = renderToStaticMarkup(<OstiumAccountCard account={account} workspace={workspace}/>);
    expect(markup).toContain("Trading account / owner wallet"); expect(markup).toContain("Agent signer");
    expect(markup).toContain("Pausing or expiry in Orcus does not remove Ostium");
    expect(markup).toContain("Collateral removal is never authorized by Orcus");
    expect(markup).toContain("Set up agent");
    expect(markup).not.toContain("Maximum trade size (USD)");
    expect(markup).not.toContain("Allowed venue symbols");
    expect(markup).toMatch(/<details[^>]*><summary>Account details/);
    const allowance = renderToStaticMarkup(<OstiumAllowanceControls account={account} workspace={workspace} initialAmount="25"/>);
    expect(allowance).toContain("No unlimited approval");
    expect(allowance).toMatch(/disabled=""[^>]*>Review allowance/);
    const compact = renderToStaticMarkup(<OstiumAllowanceControls account={account} workspace={workspace} compact/>);
    expect(compact).toContain("USDC allowance");
    expect(compact).not.toContain("Review allowance");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("translates incomplete wallet states without claiming approval succeeded", () => {
    expect(ostiumAllowanceStateLabel({ status: "submitting" } as OstiumAllowanceIntent)).toBe("Check wallet request");
    expect(ostiumAllowanceStateLabel({ status: "submitted-unknown" } as OstiumAllowanceIntent)).toBe("Check wallet request");
    expect(ostiumAllowanceStateLabel({ status: "pending" } as OstiumAllowanceIntent)).toBe("Awaiting confirmation");
    expect(ostiumAllowanceStateLabel({ status: "rejected" } as OstiumAllowanceIntent)).toBe("Not approved");
  });
});
