import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertStoragePayerAllowance, publicStoragePayerMetadata, selectStoragePayer } from "./storage-payer";
import { Store } from "./store";

const key = `0x${"1".padStart(64, "0")}`, payerAddress = privateKeyToAccount(key as `0x${string}`).address;
const env = () => ({ ZEROG_STORAGE_PAYER: "operator", ZEROG_STORAGE_SPONSOR_PRIVATE_KEY: key });
const agent = () => ({ payerAddress, privateKey: key });
const hash = (digit: string) => `0x${digit.repeat(64)}`;
let store: Store;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-06T10:00:00Z")); store = new Store(":memory:"); });
afterEach(() => { store.db.close(); vi.useRealTimers(); });
function expense(userId: string, status: string, amount0G?: string, transactionHash = hash("a"), extra: Record<string, unknown> = {}) {
  const now = Date.now();
  store.put("native-expense", { id: `${userId}:${transactionHash}`, userId, createdAt: now, updatedAt: now, kind: "storage", currency: "0g", unit: "neuron", chainId: 16602, payerAddress, transactionHash, status, maxGasWei: parseEther("0.003").toString(), maxStorageFeeWei: parseEther("0.01").toString(), ...(amount0G ? { totalSpentWei: parseEther(amount0G).toString() } : {}), observedAt: now, ...extra });
}

describe("optional operator storage sponsorship", () => {
  it("selects a real derived sponsor without reading the agent signer or leaking keys", () => {
    const user = store.ensureUser(`0x${"2".repeat(40)}`), resolver = vi.fn(agent);
    const payer = selectStoragePayer(store, user, { agent: resolver }, env());
    expect(payer).toMatchObject({ payerAddress, privateKey: key, scope: `storage-payer:${payerAddress.toLowerCase()}`, costBearer: "operator", limits: { maxGas0G: "0.003", maxStorageFee0G: "0.01" } });
    expect(resolver).not.toHaveBeenCalled();
    expect(publicStoragePayerMetadata(store, payer)).toMatchObject({ userNeeds0G: false, dailyCap0G: "0.05", dailySpent0G: "0", reserved0G: "0" });
    expect(JSON.stringify(publicStoragePayerMetadata(store, payer))).not.toContain(key);
    expect(JSON.stringify(payer)).not.toContain(key);
  });
  it("preserves isolated agent mode and rejects a mismatched signer", () => {
    const user = store.ensureUser(`0x${"2".repeat(40)}`);
    const payer = selectStoragePayer(store, user, { agent }, {});
    expect(payer).toMatchObject({ costBearer: "agent", scope: `operating:${user.id}` });
    expect(publicStoragePayerMetadata(store, payer).userNeeds0G).toBe(true);
    expect(() => selectStoragePayer(store, user, { agent: () => ({ privateKey: key, payerAddress: user.address }) }, {})).toThrow(/does not match/);
  });
  it("validates exact modes, positive decimal limits and actual secp256k1 private keys", () => {
    const user = store.ensureUser(`0x${"2".repeat(40)}`);
    for (const patch of [{ ZEROG_STORAGE_PAYER: "Operator" }, { ZEROG_STORAGE_SPONSOR_PRIVATE_KEY: "secret" }, { ZEROG_STORAGE_SPONSOR_PRIVATE_KEY: `0x${"0".repeat(64)}` }, { ZEROG_STORAGE_SPONSOR_PRIVATE_KEY: `0x${"f".repeat(64)}` }, { ZEROG_STORAGE_SPONSOR_MAX_GAS_0G: "0" }, { ZEROG_STORAGE_SPONSOR_MAX_STORAGE_FEE_0G: "1e-3" }, { ZEROG_STORAGE_SPONSOR_DAILY_CAP_0G: "-1" }, { ZEROG_STORAGE_SPONSOR_DAILY_CAP_0G: "0.0000000000000000001" }]) expect(() => selectStoragePayer(store, user, { agent }, { ...env(), ...patch })).toThrow();
    expect(() => selectStoragePayer(store, user, { agent }, { ZEROG_STORAGE_PAYER: "operator" })).toThrow(/server-only signing key/);
  });
  it("allows lower requested limits but never raises operator ceilings", () => {
    const user = store.ensureUser(`0x${"2".repeat(40)}`);
    expect(selectStoragePayer(store, user, { agent, limits: { maxGas0G: "0.001", maxStorageFee0G: "0.005" } }, env()).limits).toEqual({ maxGas0G: "0.001", maxStorageFee0G: "0.005" });
    expect(() => selectStoragePayer(store, user, { agent, limits: { maxGas0G: "0.004" } }, env())).toThrow(/exceed/);
    expect(() => selectStoragePayer(store, user, { agent, limits: { maxStorageFee0G: "0.011" } }, env())).toThrow(/exceed/);
  });
  it("caps all tenants' actual native costs including reverted gas, with exact boundary handling", () => {
    const first = store.ensureUser(`0x${"2".repeat(40)}`), second = store.ensureUser(`0x${"3".repeat(40)}`);
    const payer = selectStoragePayer(store, second, { agent }, env());
    expense(first.id, "confirmed", "0.036", hash("a")); expense(second.id, "reverted", "0.001", hash("b"));
    expect(() => assertStoragePayerAllowance(store, payer)).not.toThrow();
    expense(first.id, "confirmed", "0.000000000000000001", hash("c"));
    expect(() => assertStoragePayerAllowance(store, payer)).toThrow(/UTC-day native storage cap/);
    expect(publicStoragePayerMetadata(store, payer).dailySpent0G).toBe("0.037000000000000001");
  });
  it("blocks other users' or earlier-day uncertain transactions and counts native reservations", () => {
    const first = store.ensureUser(`0x${"2".repeat(40)}`), second = store.ensureUser(`0x${"3".repeat(40)}`);
    const payer = selectStoragePayer(store, second, { agent }, env());
    expense(first.id, "reserved", undefined, hash("a"), { observedAt: Date.now() - 86_400_000 });
    expect(() => assertStoragePayerAllowance(store, payer, hash("a"))).toThrow(/unresolved transaction/);
    expect(publicStoragePayerMetadata(store, payer)).toMatchObject({ reserved0G: "0.013", pending: true });
  });
  it("permits its own exact signed reservation without charging the cap twice", () => {
    const user = store.ensureUser(`0x${"2".repeat(40)}`), payer = selectStoragePayer(store, user, { agent }, env());
    expense(user.id, "confirmed", "0.037", hash("a")); expense(user.id, "submitted-unknown", undefined, hash("b"));
    expect(() => assertStoragePayerAllowance(store, payer)).toThrow(/unresolved/);
    expect(() => assertStoragePayerAllowance(store, payer, hash("b"))).not.toThrow();
    const smaller = selectStoragePayer(store, user, { agent, limits: { maxGas0G: "0.001" } }, env());
    expect(() => assertStoragePayerAllowance(store, smaller, hash("b"))).toThrow(/selected native limits/);
  });
  it("resets observed actual costs at UTC midnight but never forgets an unknown write", () => {
    const user = store.ensureUser(`0x${"2".repeat(40)}`), payer = selectStoragePayer(store, user, { agent }, env());
    expense(user.id, "confirmed", "0.05");
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    expect(() => assertStoragePayerAllowance(store, payer)).not.toThrow();
    expect(publicStoragePayerMetadata(store, payer)).toMatchObject({ utcDay: "2026-11-07", dailySpent0G: "0" });
    expense(user.id, "submitted-unknown", undefined, hash("b"), { observedAt: Date.now() - 86_400_000 });
    expect(() => assertStoragePayerAllowance(store, payer)).toThrow(/unresolved/);
  });
  it("does not count a duplicate transaction twice or costs paid by another wallet", () => {
    const first = store.ensureUser(`0x${"2".repeat(40)}`), second = store.ensureUser(`0x${"3".repeat(40)}`), payer = selectStoragePayer(store, second, { agent }, env());
    expense(first.id, "confirmed", "0.02"); expense(second.id, "confirmed", "0.02");
    expense(first.id, "confirmed", "0.05", hash("b"), { payerAddress: first.address });
    expense(first.id, "confirmed", "0.05", hash("c"), { chainId: 1, currency: "eth", unit: "wei" });
    expect(publicStoragePayerMetadata(store, payer).dailySpent0G).toBe("0.02");
    expect(() => assertStoragePayerAllowance(store, payer)).not.toThrow();
  });
  it("fails closed on malformed ledger amounts, states or future timestamps", () => {
    const user = store.ensureUser(`0x${"2".repeat(40)}`), payer = selectStoragePayer(store, user, { agent }, env());
    expense(user.id, "confirmed", undefined, hash("a"));
    expect(() => assertStoragePayerAllowance(store, payer)).toThrow(/ledger/);
    expense(user.id, "other-state", "0", hash("a"));
    expect(() => assertStoragePayerAllowance(store, payer)).toThrow(/unknown native expense/);
    expense(user.id, "confirmed", "0.001", hash("a"), { observedAt: Date.now() + 60_001 });
    expect(() => assertStoragePayerAllowance(store, payer)).toThrow(/untrusted timestamp/);
  });
});
