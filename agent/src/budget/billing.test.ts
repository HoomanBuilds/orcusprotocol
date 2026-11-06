import { describe, expect, it } from "vitest";
import { estimateUsageUsd, parseRouterBalance, parseRouterBilling } from "./billing";

describe("0G billing units", () => {
  it("preserves actual neuron charges separately from the provider USD equivalent", () => {
    expect(parseRouterBilling({ currency: "0g", input_cost: "2559804783711", output_cost: "7528837599105", total_cost: "10088642382816", total_cost_usd_micro: "2" })).toEqual({ source: "0g-router-trace", currency: "0g", inputCost: "2559804783711", outputCost: "7528837599105", totalCost: "10088642382816", totalCostUsdMicro: "2", costUsd: "0.000002", nativeUnit: "neuron" });
  });
  it("accepts USD mode only when its micro-dollar charge is consistent", () => {
    expect(parseRouterBilling({ currency: "usd", input_cost: "2", output_cost: "3", total_cost: "5", total_cost_usd_micro: "5" })).toMatchObject({ costUsd: "0.000005", nativeUnit: "usd-micro" });
    expect(parseRouterBilling({ currency: "usd", input_cost: "2", output_cost: "3", total_cost: "5", total_cost_usd_micro: "5000000" })).toBeUndefined();
  });
  it("rejects ambiguous, negative, inconsistent or imprecise provider costs", () => {
    for (const value of [null, {}, { currency: "usd", input_cost: "-1" }, { currency: "0g", input_cost: "1", output_cost: "2", total_cost: "4", total_cost_usd_micro: "1" }, { currency: "0g", input_cost: 1e30, output_cost: "0", total_cost: "1000000000000000000000000000000", total_cost_usd_micro: "1" }]) expect(parseRouterBilling(value)).toBeUndefined();
  });
  it("never interprets USD micros as 0G neurons", () => {
    expect(parseRouterBalance({ currency: "usd", address: `0x${"1".repeat(40)}`, total_balance: "2500000", deposit_balance: "2000000", credit_balance: "500000" })).toMatchObject({ currency: "usd", unit: "USD", balance: "2.5", balanceUsdMicro: "2500000" });
    expect(parseRouterBalance({ currency: "0g", address: `0x${"1".repeat(40)}`, total_balance: "2000000000000000000", deposit_balance: "1000000000000000000" })).toMatchObject({ currency: "0g", unit: "0G", balance: "2" });
    expect(parseRouterBalance({ currency: "usd", address: `0x${"1".repeat(40)}`, total_balance: 1e30 })).toBeUndefined();
  });
  it("keeps catalog estimates distinct and conservatively rounds fractional micros", () => {
    expect(estimateUsageUsd({ prompt: "0.00000008", completion: "0.00000048" }, { prompt_tokens: 17, completion_tokens: 5 })).toBe("0.000004");
    expect(estimateUsageUsd({ prompt: "0.000000000000001", completion: "0" }, { prompt_tokens: 1, completion_tokens: 0 })).toBe("0.000001");
    expect(estimateUsageUsd({ prompt: "1e-6", completion: "0" }, { prompt_tokens: 1, completion_tokens: 0 })).toBeUndefined();
  });
});
