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
  it("distinguishes the deposit owner from the trading gas payer", () => {
    expect(displayError({ code: "INSUFFICIENT_GAS" })).toMatch(/external-wallet deposits/);
  });
  it.each([
    { code: "PREFLIGHT_FAILED", expected: "Wallet checks failed before sending. Check your connection and try again." },
    { code: "ALLOWANCE_CLAIM_MISMATCH", expected: "Another wallet attempt owns this approval request. Check the existing request before retrying." },
  ])("explains $code without exposing diagnostics or overriding uncertain submission", ({ code, expected }) => {
    const error = new ApiError(code, "private provider credential 0xdeadbeef", 409);
    expect(displayError(error)).toBe(expected);
    expect(displayError({ cause: error })).toBe(expected);
    expect(displayError({ phase: "submitted-unknown", cause: error })).toMatch(/do not submit a replacement/);
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
  it("directs an unfunded smart account to its own Sepolia address", () => {
    expect(displayError({ code: "SMART_ACCOUNT_GAS_INSUFFICIENT" })).toMatch(/Accounts.*trading address, not the agent signer/);
    expect(displayError({ code: "GAS_LIMIT_EXCEEDED" })).toMatch(/Nothing was submitted/);
    expect(displayError({ code: "INSUFFICIENT_NATIVE_BALANCE" })).toMatch(/swap input plus enough ETH left for gas/);
  });
  it("keeps failed fee checks and recorded operations actionable without exposing provider data", () => {
    for (const code of ["INVALID_GAS_ESTIMATE", "GAS_BALANCE_UNAVAILABLE"]) {
      expect(displayError({ code, message: "private provider credential" })).toMatch(/Refresh/);
      expect(displayError({ code, message: "private provider credential" })).not.toMatch(/private provider credential/);
    }
    expect(displayError({ code: "USER_OPERATION_ALREADY_RECORDED" })).toMatch(/same operation.*do not submit a replacement/);
  });
  it.each(["SPONSORSHIP_ALREADY_SUBMITTED", "SPONSORSHIP_RECEIPT_PENDING"])("preserves recovery for legacy %s operations", code => {
    expect(displayError({ code })).toMatch(/existing activity/);
    expect(displayError({ code })).toMatch(/do not (?:send|submit)/);
    expect(displayError({ code, phase: "submitted-unknown" })).toMatch(/do not submit a replacement/);
  });
  it("does not request legacy sponsor setup or expose provider diagnostics", () => {
    const message = displayError({ code: "SPONSORSHIP_NEW_UPSTREAM_ERROR", message: "provider credential not-public" });
    expect(message).toMatch(/legacy.*no longer supported/);
    expect(message).not.toMatch(/credential|not-public|configure/);
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
