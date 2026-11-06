import { describe, expect, it } from "vitest";
import { workerConfiguration } from "./worker-config";

const token = "unit-test-internal-token-".repeat(2);
describe("automation worker configuration", () => {
  it("uses the private loopback destination independently of the public login origin", () => {
    expect(workerConfiguration({ ORCUS_INTERNAL_TOKEN: token, ORCUS_APP_URL: "https://demo.example", ORCUS_INTERNAL_APP_URL: "http://127.0.0.1:3000" })).toEqual({ tickUrl: "http://127.0.0.1:3000/api/internal/tick", token, intervalMs: 10_000 });
  });
  it("preserves the public URL and loopback fallbacks", () => {
    expect(workerConfiguration({ ORCUS_INTERNAL_TOKEN: token, ORCUS_APP_URL: "https://demo.example/", ORCUS_INTERNAL_APP_URL: "" }).tickUrl).toBe("https://demo.example/api/internal/tick");
    expect(workerConfiguration({ ORCUS_INTERNAL_TOKEN: token }).tickUrl).toBe("http://127.0.0.1:3000/api/internal/tick");
  });
  it.each([["0", 5000], ["-1", 5000], ["5001", 5001], ["300001", 300000], ["Infinity", 10000], ["invalid", 10000]])("retains bounded polling intervals", (value, expected) => {
    expect(workerConfiguration({ ORCUS_INTERNAL_TOKEN: token, ORCUS_WORKER_INTERVAL_MS: value as string }).intervalMs).toBe(expected);
  });
  it.each([undefined, "short", " ".repeat(40)])("rejects a missing or invalid shared credential", value => {
    expect(() => workerConfiguration({ ORCUS_INTERNAL_TOKEN: value })).toThrow(/ORCUS_INTERNAL_TOKEN/);
  });
  it.each(["file:///etc/passwd", "https://user:pass@demo.example", "https://demo.example/path", "https://demo.example?token=x", "not-a-url"])("rejects unsuitable worker destinations", value => {
    expect(() => workerConfiguration({ ORCUS_INTERNAL_TOKEN: token, ORCUS_INTERNAL_APP_URL: value })).toThrow(/worker application URL/);
  });
});
