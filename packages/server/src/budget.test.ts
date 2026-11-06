import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke0G } from "../../../agent/src/compute/transport";
import { getBudget, reserveBudget, setBudget, settleComputeReservation } from "./budget";
import { Store } from "./store";

const billing = { currency: "0g", input_cost: "2559804783711", output_cost: "7528837599105", total_cost: "10088642382816", total_cost_usd_micro: "2" };
afterEach(() => { vi.unstubAllGlobals(); });

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
  it.each([400, 401, 402, 403, 404, 429])("records a booked charge from an HTTP %s error instead of releasing it as free", async status => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"3".repeat(40)}`);
      setBudget(store, user.id, "1", "0.1", false);
      reserveBudget(store, user.id, "billed-error", "0.01");
      const fetch = vi.fn(async () => Response.json({ x_0g_trace: { request_id: "billed-error-request", billing } }, { status }));
      vi.stubGlobal("fetch", fetch);
      await expect(invoke0G({ url: "https://router-api.0g.ai/v1/chat/completions", apiKey: "fixture-inference-key", model: "fixture-model", messages: [], callId: "billed-error", maxTokens: 100, timeoutMs: 1000, context: { modelBudget: { beforeCall: async () => {}, afterCall: async input => { settleComputeReservation(store, user.id, "billed-error", input); } } } })).rejects.toMatchObject({ code: "INFERENCE_REJECTED" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000002", reservedUsd: "0.000000" });
      expect(getBudget(store, user.id).expenses[0]).toMatchObject({ status: "settled", evidence: { requestId: "billed-error-request", billingStatus: "provider-reported" } });
      settleComputeReservation(store, user.id, "billed-error", { outcome: "rejected", requestId: "billed-error-request", billing });
      expect(getBudget(store, user.id).spentUsd).toBe("0.000002");
    } finally { store.db.close(); }
  });
  it.each([billing, { total_cost: "123" }, null])("holds rejected calls with billing evidence but no verifiable request identity", recordedBilling => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"4".repeat(40)}`);
      setBudget(store, user.id, "1", "0.1", false);
      reserveBudget(store, user.id, "uncertain-error", "0.01");
      settleComputeReservation(store, user.id, "uncertain-error", { outcome: "rejected", billing: recordedBilling });
      expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000000", reservedUsd: "0.010000" });
      expect(getBudget(store, user.id).expenses[0].status).toBe("unknown");
    } finally { store.db.close(); }
  });
  it("releases a genuine pre-call rejection without request identity or billing", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser(`0x${"5".repeat(40)}`);
      setBudget(store, user.id, "1", "0.1", false);
      reserveBudget(store, user.id, "pre-call-reject", "0.01");
      settleComputeReservation(store, user.id, "pre-call-reject", { outcome: "rejected" });
      expect(getBudget(store, user.id)).toMatchObject({ spentUsd: "0.000000", reservedUsd: "0.000000" });
      expect(getBudget(store, user.id).expenses[0].status).toBe("released");
    } finally { store.db.close(); }
  });
});
