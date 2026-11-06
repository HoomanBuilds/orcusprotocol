import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputeFundingPanel, computeFundingAmount, computeFundingBlockReason } from "./compute-funding-panel";

vi.mock("../trading/primitives", () => ({
  Address: ({ value }: { value?: string }) => value ?? "Not created",
  Badge: ({ children }: { children: React.ReactNode }) => children,
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => <label>{label}{children}</label>,
  InlineError: ({ message }: { message?: string }) => message ?? null,
  Spinner: () => "Loading",
  Status: ({ value }: { value: string }) => value,
}));

const now = Date.now();
const verified = { status: "verified", source: "0g-router", chainId: 16602, currency: "0g" as const, accountAddress: `0x${"1".repeat(40)}`, observedAt: now, balanceBaseUnits: "123456789123456789" };
afterEach(() => vi.unstubAllGlobals());

describe("compute funding amount display", () => {
  it("preserves exact 18-decimal policy and receipt amounts without treating native 0G as USD", () => {
    expect(computeFundingAmount("123456789123456789", true)).toBe("0.123456789123456789 0G");
    expect(computeFundingAmount("0.000000000000000001")).toBe("0.000000000000000001 0G");
    expect(computeFundingAmount("0")).toBe("0 0G");
    expect(computeFundingAmount("0", true)).toBe("0 0G");
  });
  it.each([undefined, "", "-1", "NaN", "1e-18", "0.1234567891234567899"]) ("does not fabricate an amount from invalid input", value => {
    expect(computeFundingAmount(value)).toBe("Unavailable");
  });
});

describe("owner funding eligibility", () => {
  it("accepts only fresh native Galileo Router evidence for an exact beneficiary", () => {
    expect(computeFundingBlockReason(verified, now)).toBeUndefined();
    expect(computeFundingBlockReason({ ...verified, observedAt: now - 60_000 }, now)).toBeUndefined();
  });
  it.each([
    [undefined, /management balance/],
    [{ ...verified, status: "unconfigured" }, /management balance/],
    [{ ...verified, source: "custom-legacy" }, /management balance/],
    [{ ...verified, currency: "usd" as const }, /billed in USD/],
    [{ ...verified, currency: undefined }, /billing currency/],
    [{ ...verified, chainId: 16661 }, /Galileo testnet only/],
    [{ ...verified, chainId: undefined }, /Galileo testnet only/],
    [{ ...verified, accountAddress: "invalid" }, /beneficiary address/],
    [{ ...verified, observedAt: now - 60_001 }, /stale/],
    [{ ...verified, observedAt: now + 60_001 }, /stale/],
    [{ ...verified, balanceBaseUnits: undefined }, /native account balance/],
  ])("explains why unsupported or stale evidence cannot authorize funding", (input, reason) => {
    expect(computeFundingBlockReason(input as typeof verified | undefined, now)).toMatch(reason as RegExp);
  });
});

describe("initial owner funding controls", () => {
  it("starts disabled and never fetches or broadcasts during server rendering", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const markup = renderToStaticMarkup(React.createElement(ComputeFundingPanel, { onRefresh: vi.fn(async () => undefined) }));
    expect(markup).toContain("Compute account replenishment");
    expect(markup).toContain("USD expense caps and native 0G deposit caps are separate");
    expect(markup).toMatch(/disabled=""[^>]*>Enable capped replenishment/);
    expect(markup).toMatch(/disabled=""[^>]*>Disable new deposits/);
    expect(markup).toMatch(/disabled=""[^>]*>Check threshold and prepare deposit/);
    expect(markup).not.toMatch(/type="checkbox"[^>]*checked=/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
