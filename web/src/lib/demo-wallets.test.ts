import { afterEach, describe, expect, it, vi } from "vitest";
import * as wallet from "./wallets";

afterEach(() => vi.unstubAllGlobals());
describe("demo wallet entrypoints", () => {
  it.each(Object.keys(wallet) as Array<keyof typeof wallet>)("blocks %s before reaching an injected provider", async name => {
    const request = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => "enabled" }, ethereum: { request } });
    const action = wallet[name] as (...args: unknown[]) => Promise<unknown>;
    await expect(action()).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
    expect(request).not.toHaveBeenCalled();
  });
});
