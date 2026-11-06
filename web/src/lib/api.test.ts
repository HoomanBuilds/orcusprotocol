import { describe, expect, it } from "vitest";
import { ApiError, displayError } from "./api";

describe("safe actionable wallet and API errors", () => {
  it("recognizes nested wallet cancellation and already pending wallet requests", () => {
    expect(displayError({ cause: { cause: { code: 4001 } } })).toMatch(/Cancelled/);
    expect(displayError({ code: -32002 })).toMatch(/request is already open/);
  });
  it("prioritizes uncertain submission recovery instead of suggesting a second transaction", () => {
    expect(displayError(Object.assign(new Error("network timeout with private details"), { phase: "submitted-unknown" }))).toMatch(/do not submit a replacement/);
    expect(displayError({ phase: "submitted-unknown", cause: { code: 4001, message: "user rejected" } })).toMatch(/do not submit a replacement/);
    expect(displayError({ code: "QUOTE_EXPIRED" })).toMatch(/fresh quote/);
  });
  it("separates the owner-paid initial deposit fee from sponsored trading", () => {
    expect(displayError({ code: "INSUFFICIENT_GAS" })).toMatch(/external-wallet deposits/);
  });
  it.each(["PAYMASTER_UNCONFIGURED", "SPONSORSHIP_UNCONFIGURED", "SPONSORSHIP_REJECTED"]) ("does not offer owner-paid fallback for %s", code => {
    expect(displayError({ code })).toMatch(/owner-paid/);
  });
  it("uses safe code-based instructions without reflecting provider messages, credentials, or raw revert data", () => {
    const secret = `Bearer ${"not-a-real-token".repeat(30)}`;
    const raw = new ApiError("VENUE_REJECTED", `${secret} https://rpc.example/key 0xdeadbeef`, 400);
    expect(displayError(raw)).toMatch(/Review balances/);
    expect(displayError(raw)).not.toContain(secret);
    expect(displayError(new Error(secret))).not.toContain("Bearer");
    expect(displayError(new ApiError("UNKNOWN_PROVIDER_CODE", secret, 502))).not.toContain(secret);
  });
  it("survives cyclic or hostile error objects without echoing their content", () => {
    const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
    expect(displayError(cyclic)).toMatch(/could not be completed/);
    expect(displayError({ get code() { throw new Error("secret"); } })).not.toContain("secret");
  });
});
