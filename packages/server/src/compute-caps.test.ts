import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "./store";
import { getBudget, reserveBudget, setBudget, settleReservation } from "./budget";
import { AgentRun } from "./agent-runtime";

let store: Store;
beforeEach(() => { store = new Store(":memory:"); vi.stubEnv("ORCUS_SERVICE_PAYMENT_MODE", "disabled"); vi.stubEnv("ORCUS_COMPUTE_USER_DAILY_USD", "1"); vi.stubEnv("ORCUS_COMPUTE_PROJECT_DAILY_USD", "10"); });
afterEach(() => { store.db.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function user(digit = "1") { const owner = store.ensureUser(`0x${digit.repeat(40)}`); setBudget(store, owner.id, "100", "0.1", false); return owner; }

describe("operator-controlled compute ceilings", () => {
  it("permits the exact user boundary but owner cap edits and duplicate references cannot enlarge it", () => {
    const owner = user(); expect(reserveBudget(store, owner.id, "first", "1")).toBe(true);
    expect(reserveBudget(store, owner.id, "first", "1")).toBe(false);
    setBudget(store, owner.id, "100000", "0", false);
    expect(() => reserveBudget(store, owner.id, "above", "0.000001")).toThrow(/operator-paid/);
    expect(getBudget(store, owner.id).reservedUsd).toBe("1.000000");
  });
  it("serializes concurrent tenant reservations against one exact shared ceiling", async () => {
    vi.stubEnv("ORCUS_COMPUTE_PROJECT_DAILY_USD", "0.015");
    const first = user("1"), second = user("2");
    const result = await Promise.allSettled([Promise.resolve().then(() => reserveBudget(store, first.id, "one", "0.01")), Promise.resolve().then(() => reserveBudget(store, second.id, "two", "0.01"))]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(result.find(value => value.status === "rejected")).toMatchObject({ reason: { code: "OPERATOR_COMPUTE_PROJECT_CAP" } });
    expect(getBudget(store, first.id).reservedUsd).toBe("0.010000");
    expect(getBudget(store, second.id).reservedUsd).toBe("0.000000");
  });
  it("holds unresolved reservations across midnight while settled charges follow actual settlement day", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-06T23:59:50Z"));
    const owner = user(); reserveBudget(store, owner.id, "pending", "0.75"); settleReservation(store, owner.id, "pending", "unknown");
    vi.setSystemTime(new Date("2026-11-07T00:00:10Z"));
    expect(() => reserveBudget(store, owner.id, "new", "0.250001")).toThrow(/operator-paid/);
    settleReservation(store, owner.id, "pending", "settled", { operatorSettledAt: 0 }, "0.25");
    expect(reserveBudget(store, owner.id, "today", "0.75")).toBe(true);
    expect(() => reserveBudget(store, owner.id, "today-over", "0.000001")).toThrow(/operator-paid/);
    vi.setSystemTime(new Date("2026-11-08T00:00:10Z"));
    expect(reserveBudget(store, owner.id, "tomorrow", "0.25")).toBe(true);
    expect(() => reserveBudget(store, owner.id, "tomorrow-over", "0.000001")).toThrow(/operator-paid/);
  });
  it("releases rejected calls and uses the actual settled charge without charging repeated settlement", () => {
    const owner = user(); reserveBudget(store, owner.id, "rejected", "1"); settleReservation(store, owner.id, "rejected", "released");
    reserveBudget(store, owner.id, "completed", "1"); settleReservation(store, owner.id, "completed", "settled", {}, "0.000001");
    settleReservation(store, owner.id, "completed", "settled", {}, "1");
    expect(reserveBudget(store, owner.id, "remaining", "0.999999")).toBe(true);
    expect(() => reserveBudget(store, owner.id, "excess", "0.000001")).toThrow(/operator-paid/);
  });
  it("rejects zero reservations and invalid operator configuration before any provider work starts", () => {
    const owner = user(); expect(() => reserveBudget(store, owner.id, "zero", "0")).toThrow(/positive/);
    vi.stubEnv("ORCUS_COMPUTE_USER_DAILY_USD", "1.0000001");
    expect(() => reserveBudget(store, owner.id, "invalid", "0.01")).toThrow(/ceilings are invalid/);
    vi.stubEnv("ORCUS_COMPUTE_USER_DAILY_USD", "0");
    const run = new AgentRun(store, owner.id, "blocked-run", "Read market prices");
    expect(() => run.start()).toThrow(/operator-paid/);
    expect(store.list(owner.id, "agent-run")).toHaveLength(0);
    expect(getBudget(store, owner.id).reservedUsd).toBe("0.000000");
  });
});
