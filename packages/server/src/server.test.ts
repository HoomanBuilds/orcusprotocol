import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getBudget, reserveBudget, setBudget, settleReservation } from "./budget";
import { handleRequest, readBody } from "./http";
import { Store } from "./store";

const origin = "http://localhost:3000";
let runtimeDirectory: string;
beforeAll(() => { runtimeDirectory = mkdtempSync(join(tmpdir(), "orcus-server-")); vi.stubEnv("ORCUS_DATA_DIR", runtimeDirectory); vi.stubEnv("ORCUS_APP_URL", origin); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(runtimeDirectory, { recursive: true, force: true }); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("owner authentication", () => {
  it("requires an owner signature, consumes the nonce once and isolates private routes", async () => {
    const store = new Store(":memory:");
    try {
      const owner = privateKeyToAccount(generatePrivateKey());
      const challengeResponse = await handleRequest(post("auth/challenge", { address: owner.address }), store);
      expect(challengeResponse.status).toBe(200);
      const { data: challenge } = await challengeResponse.json() as { data: { id: string; message: string } };
      const signature = await owner.signMessage({ message: challenge.message });
      const login = await handleRequest(post("auth/verify", { challengeId: challenge.id, signature }), store);
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).toContain("HttpOnly");
      expect(login.headers.get("set-cookie")).toContain("SameSite=Lax");
      const token = login.headers.get("set-cookie")!.split(";")[0];
      const session = await handleRequest(new Request(`${origin}/api/session`, { headers: { Cookie: token } }), store);
      expect((await session.json()).data.user.address).toBe(owner.address.toLowerCase());
      const replay = await handleRequest(post("auth/verify", { challengeId: challenge.id, signature }), store);
      expect(replay.status).toBe(401);
      const privateRead = await handleRequest(new Request(`${origin}/api/activity`), store);
      expect(privateRead.status).toBe(401);
    } finally { store.db.close(); }
  });
  it("rejects cross-site account changes before creating an account", async () => {
    const store = new Store(":memory:");
    try {
      const response = await handleRequest(post("auth/challenge", { address: "0x1111111111111111111111111111111111111111" }, { Origin: "https://other.invalid" }), store);
      expect(response.status).toBe(403);
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM challenges").get()).toEqual({ count: 0 });
    } finally { store.db.close(); }
  });
  it("does not return operator RPC credentials in wallet configuration", async () => {
    vi.stubEnv("SEPOLIA_RPC_URL", "https://rpc.invalid/operator-secret");
    const response = await handleRequest(new Request(`${origin}/api/wallet-config`));
    const result = await response.text();
    expect(result).toContain('"rpcUrl":"/api/rpc"');
    expect(result).not.toContain("operator-secret");
  });
});

describe("durable limits", () => {
  it("reserves funds atomically, deduplicates charges and retains unknown billing", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser("0x1111111111111111111111111111111111111111");
      setBudget(store, user.id, "1", "0.1", false);
      expect(reserveBudget(store, user.id, "evaluation", "0.75")).toBe(true);
      expect(reserveBudget(store, user.id, "evaluation", "0.75")).toBe(false);
      expect(() => reserveBudget(store, user.id, "another", "0.5")).toThrow("exhausted");
      settleReservation(store, user.id, "evaluation", "unknown");
      expect(getBudget(store, user.id).reservedUsd).toBe("0.750000");
      expect(() => setBudget(store, user.id, "0.1", "0.01", false)).toThrow("reserved");
    } finally { store.db.close(); }
  });
  it("will not renew or release another worker's lease", () => {
    const store = new Store(":memory:");
    try {
      expect(store.takeLease("account", "first", 180_000)).toBe(true);
      expect(store.takeLease("account", "second", 180_000)).toBe(false);
      expect(store.renewLease("account", "second", 180_000)).toBe(false);
      store.releaseLease("account", "second");
      expect(store.renewLease("account", "first", 180_000)).toBe(true);
    } finally { store.db.close(); }
  });
  it("rejects oversized request streams", async () => {
    await expect(readBody(post("budget", { payload: "x".repeat(33_000) }))).rejects.toThrow("too large");
  });
});
