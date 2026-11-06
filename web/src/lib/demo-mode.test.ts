import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_MODE_KEY, guardWalletAction, isDemoMode, setDemoMode } from "./demo-mode";

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("explicit demo mode", () => {
  it("is off by default and persists only the opt-in flag", () => {
    expect(isDemoMode()).toBe(false);
    setDemoMode(true);
    expect(isDemoMode()).toBe(true);
    expect([...values]).toEqual([[DEMO_MODE_KEY, "enabled"]]);
    setDemoMode(false);
    expect(isDemoMode()).toBe(false);
    expect(values.size).toBe(0);
  });
  it("rejects before calling any wallet action", async () => {
    const provider = vi.fn(async () => "signed");
    const guarded = guardWalletAction(provider);
    setDemoMode(true);
    await expect(guarded()).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
    expect(provider).not.toHaveBeenCalled();
  });
  it("does not change accounts while a wallet operation is in flight", async () => {
    let release!: () => void;
    const guarded = guardWalletAction(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = guarded();
    expect(() => setDemoMode(true)).toThrow(/current wallet request/);
    expect(isDemoMode()).toBe(false);
    release(); await pending;
    setDemoMode(true);
    expect(isDemoMode()).toBe(true);
  });
  it("releases the operation lock on failures", async () => {
    const guarded = guardWalletAction(async () => { throw new Error("cancelled"); });
    await expect(guarded()).rejects.toThrow("cancelled");
    setDemoMode(true);
    expect(isDemoMode()).toBe(true);
  });
  it("requires working browser persistence to opt in", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => undefined } });
    expect(() => setDemoMode(true)).toThrow(/could not be saved/);
  });
  it("keeps demo wallet guards closed if storage becomes unreadable", async () => {
    setDemoMode(true);
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("storage blocked"); } } });
    const provider = vi.fn(async () => "signed");
    await expect(guardWalletAction(provider)()).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
    expect(provider).not.toHaveBeenCalled();
  });
});
