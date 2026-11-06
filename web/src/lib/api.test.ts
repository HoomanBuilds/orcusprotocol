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
  it.each([
    { code: "UNSUPPORTED_MARKET", expected: /supported market/ },
    { code: "TOKEN_DIRECTION_MISMATCH", expected: /buy\/sell direction/ },
    { code: "TRADE_LIMIT", expected: /approved limit/ },
  ])("explains $code without exposing venue diagnostics or bypassing rejection", ({ code, expected }) => {
    const error = new ApiError(code, "private upstream diagnostics 0xdeadbeef", 422);
    expect(displayError(error)).toMatch(expected);
    expect(displayError({ cause: error })).toMatch(expected);
    expect(displayError(error)).not.toMatch(/diagnostics|0xdeadbeef|retry|bypass/);
    expect(displayError({ phase: "submitted-unknown", cause: error })).toMatch(/do not submit a replacement/);
  });
  it.each(["PAYMASTER_UNCONFIGURED", "SPONSORSHIP_UNCONFIGURED", "SPONSORSHIP_REJECTED"]) ("does not offer owner-paid fallback for %s", code => {
    expect(displayError({ code })).toMatch(/owner-paid/);
  });
  it.each(["SPONSORSHIP_UNAVAILABLE", "SPONSORSHIP_USER_CAP", "SPONSORSHIP_PROJECT_CAP"]) ("explains sponsor availability or caps safely for %s", code => {
    expect(displayError({ code, message: "private provider diagnostics" })).toMatch(/owner-paid/);
    expect(displayError({ code, message: "private provider diagnostics" })).not.toContain("diagnostics");
  });
  it.each(["SPONSORSHIP_ALREADY_SUBMITTED", "SPONSORSHIP_RECEIPT_PENDING"]) ("keeps recovery monotonic for %s", code => {
    expect(displayError({ code, message: "private provider details" })).toMatch(/existing/);
    expect(displayError({ code })).toMatch(/do not (?:send|submit)/);
    expect(displayError({ code, phase: "submitted-unknown", cause: { code: 4001 } })).toMatch(/do not submit a replacement/);
  });
  it.each(["SPONSORSHIP_USER_CAP", "SPONSORSHIP_PROJECT_CAP"]) ("directs %s to reconciliation or waiting, not buying compute tokens", code => {
    const message = displayError({ code });
    expect(message).toMatch(/activity/);
    expect(message).not.toMatch(/0G|buy|provider/);
  });
  it("handles platform configuration and unknown sponsor codes without leaking or asking the customer to configure a provider", () => {
    expect(displayError({ code: "SPONSORSHIP_CONFIG_INVALID" })).toMatch(/Platform gas coverage/);
    const message = displayError({ code: "SPONSORSHIP_NEW_UPSTREAM_ERROR", message: "provider credential not-public" });
    expect(message).toMatch(/platform readiness/);
    expect(message).not.toMatch(/credential|not-public|0G|configure/);
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
