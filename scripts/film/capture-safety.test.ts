import { describe, expect, it } from "vitest";
import { allowedCaptureRequest, captureOrigin, concatFrames, recordedResearch } from "./capture-safety.mjs";

describe("film capture safety", () => {
  const origin = "http://localhost:3134";
  it("rejects main preview, remote and credentialed origins", () => {
    expect(captureOrigin(origin).origin).toBe(origin);
    for (const value of ["http://localhost:3000", "https://example.com", "http://user:pass@localhost:3134", `${origin}/api`, `${origin}/?key=1`]) expect(() => captureOrigin(value)).toThrow();
  });
  it("permits actual local sign-in/account/control but no execution", () => {
    const check = (path: string, body: object) => allowedCaptureRequest({ url: origin + path, method: "POST", postData: JSON.stringify(body) }, origin);
    expect(check("/api/accounts", { venue: "hyperliquid" })).toBe(true);
    expect(check("/api/agent/control", { command: "pause" })).toBe(true);
    expect(check("/api/agent/control", { command: "update", mode: "autonomous" })).toBe(false);
    for (const path of ["/api/agent/chat", "/api/actions/execute", "/api/automations", "/api/permissions", "/api/funding"]) expect(check(path, {})).toBe(false);
    expect(check("/api/agent/requests", { autonomous: true, message: "trade" })).toBe(false);
  });
  it("allows public readonly info calls, never exchange broadcasts", () => {
    expect(allowedCaptureRequest({ url: "https://api.hyperliquid-testnet.xyz/info", method: "POST" }, origin)).toBe(true);
    expect(allowedCaptureRequest({ url: "https://api.hyperliquid-testnet.xyz/exchange", method: "POST" }, origin)).toBe(false);
    expect(allowedCaptureRequest({ url: "https://api.hyperliquid.xyz/info", method: "POST" }, origin)).toBe(false);
  });
  it("keeps exact successful research and removes private fields", () => {
    const rows = ["read_markets", "analyze_market", "read_market_context"].flatMap((name, i) => [{ body: JSON.stringify({ id: `${i}:user`, role: "user", content: "Research only", userId: "private" }) }, { body: JSON.stringify({ id: `${i}:assistant`, role: "assistant", content: "Actual response", privateKey: "must-not-copy", toolSteps: [{ name, ok: true, sources: [{ id: "source", title: "Market", url: "https://example.com", retrievedAt: 1 }] }] }) }]);
    const output = recordedResearch(rows);
    expect(output).toHaveLength(3);
    expect(output[0].messages[1].content).toBe("Actual response");
    expect(JSON.stringify(output)).not.toContain("private");
    expect(() => recordedResearch([])).toThrow();
  });
  it("holds static frames for actual elapsed time without path injection", () => {
    expect(concatFrames([{ file: "frame-000001.jpg", at: 0 }, { file: "frame-000002.jpg", at: 2 }], 5)).toContain("duration 3.000000");
    expect(() => concatFrames([{ file: "../secret", at: 0 }], 1)).toThrow();
  });
});
