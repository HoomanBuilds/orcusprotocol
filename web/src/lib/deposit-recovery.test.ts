import { describe, expect, it } from "vitest";
import { clearDepositRecovery, depositRecoveryKey, readDepositRecovery } from "./deposit-recovery";

function storage() {
  const records = new Map<string, string>();
  return { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
}
const owner = `0x${"A".repeat(40)}`;
const transactionHash = `0x${"b".repeat(64)}`;

describe("durable account-bound deposit recovery", () => {
  it("restores only the selected owner/account after a new tab session", () => {
    const local = storage();
    local.setItem(depositRecoveryKey(owner, "one"), JSON.stringify({ status: "unknown", transactionHash }));
    expect(readDepositRecovery(local, storage(), owner.toLowerCase(), "one")).toEqual({ status: "unknown", transactionHash });
    expect(readDepositRecovery(local, storage(), owner, "two")).toBeNull();
    expect(readDepositRecovery(local, storage(), `0x${"c".repeat(40)}`, "one")).toBeNull();
  });
  it("migrates an existing case-sensitive session record and strips unrelated fields", () => {
    const local = storage(), session = storage();
    session.setItem(`orcus:trading-deposit:${owner}:one`, JSON.stringify({ status: "unknown", transactionHash, secret: "never copy" }));
    expect(readDepositRecovery(local, session, owner, "one")).toEqual({ status: "unknown", transactionHash });
    expect(JSON.parse(local.getItem(depositRecoveryKey(owner, "one"))!)).toEqual({ status: "unknown", transactionHash });
    expect(readDepositRecovery(local, storage(), owner, "one")?.status).toBe("unknown");
  });
  it("rejects malformed data and never promotes a missing hash to confirmed", () => {
    const local = storage(), session = storage(), key = depositRecoveryKey(owner, "one");
    for (const value of ["{", "null", '{"status":"confirmed"}', '{"status":"failed"}', '{"status":"confirmed","transactionHash":"no"}']) {
      local.setItem(key, value);
      expect(readDepositRecovery(local, session, owner, "one")).toBeNull();
    }
  });
  it("can read legacy recovery when durable storage is blocked and clears both stores explicitly", () => {
    const session = storage();
    session.setItem(depositRecoveryKey(owner, "one"), JSON.stringify({ status: "unknown" }));
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readDepositRecovery(blocked, session, owner, "one")).toEqual({ status: "unknown" });
    clearDepositRecovery(blocked, session, owner, "one");
    expect(session.getItem(depositRecoveryKey(owner, "one"))).toBeNull();
  });
});
