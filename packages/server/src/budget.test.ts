import { describe, expect, it } from "vitest";
import { getBudget, reserveBudget, setBudget, settleComputeReservation } from "./budget";
import { Store } from "./store";

const billing = { currency: "0g", input_cost: "2559804783711", output_cost: "7528837599105", total_cost: "10088642382816", total_cost_usd_micro: "2" };

describe("provider-reported compute expense settlement", () => {
  it("settles the USD-equivalent allowance while preserving the actual native charge", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"1".repeat(40)}`);
      setBudget(store, user.id, "1", "0.1", false);
      reserveBudget(store, user.id, "model-step", "0.01");
      settleComputeReservation(store, user.id, "model-step", { outcome: "completed", requestId: "real-provider-request", billing });
      const budget = getBudget(store, user.id);
      expect(budget.spentUsd).toBe("0.000002");
      expect(budget.reservedUsd).toBe("0.000000");
      expect(budget.expenses[0].evidence).toMatchObject({ ledgerUnit: "USD-equivalent", walletDebitCurrency: "0g", billing: { totalCost: "10088642382816", nativeUnit: "neuron" } });
      settleComputeReservation(store, user.id, "model-step", { outcome: "completed", requestId: "real-provider-request", billing });
      expect(getBudget(store, user.id).spentUsd).toBe("0.000002");
    } finally { store.db.close(); }
  });
  it("keeps unknown billing reserved instead of inventing a zero charge", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"2".repeat(40)}`);
      setBudget(store, user.id, "1", "0.1", false);
      reserveBudget(store, user.id, "missing", "0.01");
      settleComputeReservation(store, user.id, "missing", { outcome: "completed", requestId: "provider-request" });
      expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000000", reservedUsd: "0.010000" });
      settleComputeReservation(store, user.id, "missing", { outcome: "completed", billing });
      expect(getBudget(store, user.id).reservedUsd).toBe("0.010000");
    } finally { store.db.close(); }
  });
});
