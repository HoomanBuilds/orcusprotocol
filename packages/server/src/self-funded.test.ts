import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoPaymaster, selfFundedSummary } from "./self-funded";
import { handleRequest } from "./http";
import { Store } from "./store";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("self-funded execution configuration", () => {
  it("requires only the bundler and ignores invalid legacy sponsorship credentials", () => {
    vi.stubEnv("BUNDLER_RPC_URL", "https://public.pimlico.io/v2/11155111/rpc");
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "invalid");
    vi.stubEnv("ORCUS_GAS_SPONSOR_PRIVATE_KEY", "invalid");
    vi.stubEnv("ORCUS_PAYMASTER_ADDRESS", "invalid");
    expect(selfFundedSummary()).toMatchObject({ configured: true, mode: "self-funded", payer: "smart-account" });
    vi.stubEnv("BUNDLER_RPC_URL", "");
    expect(selfFundedSummary().configured).toBe(false);
  });
  it("rejects every sponsor field before forwarding a bundler call", () => {
    for (const field of ["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterAndData"]) expect(() => assertNoPaymaster({ [field]: "0x" })).toThrow(expect.objectContaining({ code: "SPONSORSHIP_DISABLED" }));
    expect(() => assertNoPaymaster({ sender: "0x1111111111111111111111111111111111111111" })).not.toThrow();
  });
  it("disables authenticated sponsor endpoints without making any external requests", async () => {
    const store = new Store(":memory:"), origin = "http://localhost:3000";
    const user = store.ensureUser("0x1111111111111111111111111111111111111111");
    const challenge = store.createChallenge(user.address, origin), session = store.createSession(challenge.id, user.address);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.stubEnv("ORCUS_APP_URL", origin);
    vi.stubEnv("ORCUS_GAS_SPONSOR_PROVIDER", "zerodev");
    vi.stubEnv("ZERODEV_PAYMASTER_RPC_URL", "https://rpc.zerodev.app/stale");
    try {
      for (const path of ["paymaster", "gas-sponsorship/reconcile"]) {
        const response = await handleRequest(new Request(`${origin}/api/${path}`, { method: "POST", headers: { Origin: origin, Cookie: `orcus_session=${session.token}` }, body: "{}" }), store);
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ error: { code: "SPONSORSHIP_DISABLED" } });
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { store.db.close(); }
  });
});
