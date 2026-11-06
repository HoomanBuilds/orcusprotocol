import { describe, expect, it } from "vitest";
import { recordStorageExpense, listStorageExpenses } from "./storage-expenses";
import { Store } from "./store";

const expense = () => ({ kind: "storage", currency: "0g", unit: "neuron", chainId: 16602, status: "submitted-unknown", transactionHash: `0x${"1".repeat(64)}`, rootHash: `0x${"2".repeat(64)}`, payerAddress: `0x${"3".repeat(40)}`, to: `0x${"4".repeat(40)}`, calldataHash: `0x${"5".repeat(64)}`, storageValueWei: "100", maxGasWei: "100000", maxStorageFeeWei: "1000", observedAt: Date.now() });
describe("separate native storage expense evidence", () => {
  it("is idempotent, user-scoped and never changes the USD inference budget", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"4".repeat(40)}`), other = store.ensureUser(`0x${"5".repeat(40)}`);
      recordStorageExpense(store, user.id, expense());
      const paid = { ...expense(), status: "confirmed", gasPaidWei: "40000", storageFeeWei: "100", totalSpentWei: "40100", blockNumber: "1" };
      recordStorageExpense(store, user.id, paid); recordStorageExpense(store, user.id, expense());
      expect(listStorageExpenses(store, user.id)).toHaveLength(1);
      expect(listStorageExpenses(store, user.id)[0]).toMatchObject({ status: "confirmed", totalSpentWei: "40100", currency: "0g" });
      expect(listStorageExpenses(store, other.id)).toHaveLength(0);
      expect(store.db.prepare("SELECT spent_micros FROM budgets WHERE user_id=?").get(user.id)).toEqual({ spent_micros: 0 });
    } finally { store.db.close(); }
  });
  it("rejects invented totals, costs above caps and charged storage on reverted transactions", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"4".repeat(40)}`);
      for (const patch of [{ status: "confirmed", gasPaidWei: "40000", storageFeeWei: "100", totalSpentWei: "10" }, { status: "confirmed", gasPaidWei: "100001", storageFeeWei: "0", totalSpentWei: "100001" }, { status: "reverted", gasPaidWei: "40000", storageFeeWei: "100", totalSpentWei: "40100" }, { status: "submitted-unknown", gasPaidWei: "1" }]) expect(() => recordStorageExpense(store, user.id, { ...expense(), ...patch })).toThrow(/expense|Unknown storage/);
    } finally { store.db.close(); }
  });
});
