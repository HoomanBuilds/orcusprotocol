import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, post } from "./api";
import { DEMO_MODE_KEY } from "./demo-mode";

let enabled: boolean;
const fetcher = vi.fn();
beforeEach(() => {
  enabled = true;
  fetcher.mockReset();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => key === DEMO_MODE_KEY && enabled ? "enabled" : null } });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("demo account request isolation", () => {
  it("serves private sample data without contacting the signed-in backend", async () => {
    const session = await api<{ user: { id: string } }>("/api/session");
    expect(session.user.id).toMatch(/^demo-/);
    for (const path of ["/api/portfolio", "/api/activity", "/api/agent", "/api/automations", "/api/budget", "/api/permissions", "/api/agent/requests", "/api/memory?query=private", "/api/agent/models", "/api/wallet-config"]) await api(path);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("blocks %s before fetch, including on public endpoints", async method => {
    for (const path of ["/api/actions/prepare", "/api/permissions", "/api/agent/requests", "/api/auth/logout", "/api/budget/payments", "/api/markets"]) await expect(api(path, { method })).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["/api/unknown", "/api/private/history", "/api/actions/demo-order", "https://external.example/api/markets", "//external.example/api/markets"])("never falls through for unknown private reads: %s", async path => {
    await expect(api(path)).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains real public market reads without substituting sample prices", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ data: { markets: [{ symbol: "ETH", midPrice: "1234" }] } }), { status: 200 }));
    const response = await api<{ markets: unknown[] }>("/api/markets?venue=hyperliquid");
    expect(response.markets).toEqual([{ symbol: "ETH", midPrice: "1234" }]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("drops real session data if demo is enabled while the request is pending", async () => {
    enabled = false;
    let release!: (value: Response) => void;
    fetcher.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const pending = api("/api/session");
    enabled = true;
    release(new Response(JSON.stringify({ data: { user: { id: "real-owner-private" } } }), { status: 200 }));
    await expect(pending).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
  });
  it("blocks stale demo entity writes after exiting demo", async () => {
    enabled = false;
    await expect(post("/api/actions/prepare", { accountId: "demo-hyperliquid" })).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses the ordinary authenticated API when demo is off", async () => {
    enabled = false;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ data: { user: { id: "real-owner" } } }), { status: 200 }));
    expect(await api("/api/session")).toEqual({ user: { id: "real-owner" } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not reject normal messages or strategy names mentioning demo examples", async () => {
    enabled = false;
    fetcher.mockResolvedValue(new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 }));
    await expect(post("/api/agent/requests", { message: "demo-example", name: "demo-strategy", accountId: "real-account" })).resolves.toEqual({ accepted: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
