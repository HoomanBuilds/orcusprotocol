import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { assertComputeFundingAuthority, cancelComputeFunding, configureComputeFunding, getComputeFundingPolicy, prepareComputeFunding, recordComputeFundingSubmission, settleComputeFunding } from "./compute-funding";
import { Store } from "./store";

const operatingAddress = `0x${"2".repeat(40)}`, computeAccountAddress = `0x${"3".repeat(40)}`, transactionHash = `0x${"4".repeat(64)}`;
const policy = () => ({ enabled: true, chainId: 16602, currency: "0g", computeAccountAddress, topUp0G: "0.1", maximumTotal0G: "0.22", lowBalance0G: "0.02", maxGas0G: "0.01", expiresAt: Date.now() + 600_000 });
const context = () => ({ operatingAddress, providerBalance: { status: "verified", source: "0g-router", chainId: 16602, currency: "0g", accountAddress: computeAccountAddress, balanceNeurons: "0", observedAt: Date.now() }, paymentVaultBalance: { source: "payment-vault", chainId: 16602, currency: "0g", accountAddress: computeAccountAddress, balanceNeurons: "0", observedAt: Date.now() } });
function setup() { const store = new Store(":memory:"); const user = store.ensureUser(`0x${"1".repeat(40)}`); return { store, user }; }

describe("owner-authorized compute replenishment", () => {
  it("requires the exact provider account, native billing mode, and separate operating payer", () => {
    const { store, user } = setup();
    try {
      const current = context();
      expect(() => configureComputeFunding(store, user, policy(), { ...current, providerBalance: { ...current.providerBalance, currency: "usd" } })).toThrow(/USD billing/);
      expect(() => configureComputeFunding(store, user, policy(), { ...current, providerBalance: { ...current.providerBalance, chainId: 16661 } })).toThrow(/Mainnet accounts/);
      expect(() => configureComputeFunding(store, user, policy(), { ...current, providerBalance: { ...current.providerBalance, accountAddress: operatingAddress } })).toThrow(/exact approved/);
      expect(() => configureComputeFunding(store, user, policy(), { ...current, providerBalance: { ...current.providerBalance, observedAt: Date.now() - 60_001 } })).toThrow(/fresh Galileo Router balance/);
      expect(() => configureComputeFunding(store, user, policy(), { ...current, operatingAddress: user.address })).toThrow(/separate agent operating wallet/);
      expect(() => configureComputeFunding(store, user, { ...policy(), maximumTotal0G: "0.1" }, current)).toThrow(/deposit and its maximum gas/);
      expect(() => configureComputeFunding(store, user, { ...policy(), expiresAt: Date.now() + 31 * 86_400_000 }, current)).toThrow(/thirty days/);
    } finally { store.db.close(); }
  });
  it("reserves exact native deposit plus gas once, with no duplicated or concurrent funding", () => {
    const { store, user } = setup();
    try {
      configureComputeFunding(store, user, policy(), context());
      const prepared = prepareComputeFunding(store, user, "request-one", context());
      expect(prepared.status).toBe("prepared");
      expect(prepareComputeFunding(store, user, "request-one", context())).toEqual(prepared);
      expect(prepareComputeFunding(store, user, "request-two", context())).toMatchObject({ status: "no-action", reason: expect.stringMatching(/previous deposit/) });
      expect(getComputeFundingPolicy(store, user)).toMatchObject({ reserved0G: "0.11", available0G: "0.11", spent0G: "0" });
      if (prepared.status !== "prepared") throw new Error("Missing intent");
      cancelComputeFunding(store, user, prepared.intent.id);
      expect(getComputeFundingPolicy(store, user).reserved0G).toBe("0");
      expect(prepareComputeFunding(store, user, "request-one", context())).toMatchObject({ status: "no-action" });
    } finally { store.db.close(); }
  });
  it("does not fund a sufficiently credited provider account", () => {
    const { store, user } = setup();
    try {
      configureComputeFunding(store, user, policy(), context());
      const current = context();
      expect(prepareComputeFunding(store, user, "not-low", { ...current, providerBalance: { ...current.providerBalance, balanceNeurons: parseEther("1").toString() } })).toMatchObject({ status: "no-action" });
      expect(getComputeFundingPolicy(store, user).intents).toHaveLength(0);
    } finally { store.db.close(); }
  });
  it("requires the real vault balance and does not duplicate funds waiting in the payment layer", () => {
    const { store, user } = setup();
    try {
      configureComputeFunding(store, user, policy(), context());
      const current = context();
      expect(() => prepareComputeFunding(store, user, "no-vault", { ...current, paymentVaultBalance: undefined })).toThrow(/PaymentVault account/);
      expect(prepareComputeFunding(store, user, "unspent-vault", { ...current, paymentVaultBalance: { ...current.paymentVaultBalance, balanceNeurons: parseEther("0.1").toString() } })).toMatchObject({ status: "no-action", reason: expect.stringMatching(/unspent PaymentVault/) });
    } finally { store.db.close(); }
  });
  it("revokes authority on disable and policy changes and never releases an uncertain broadcast", () => {
    const { store, user } = setup();
    try {
      configureComputeFunding(store, user, policy(), context());
      const prepared = prepareComputeFunding(store, user, "pending", context());
      if (prepared.status !== "prepared") throw new Error("Missing intent");
      recordComputeFundingSubmission(store, user, prepared.intent.id, transactionHash);
      settleComputeFunding(store, user, prepared.intent.id, { status: "submitted-unknown", transactionHash, chainId: 16602, creditStatus: "unconfirmed" });
      expect(() => cancelComputeFunding(store, user, prepared.intent.id)).toThrow(/Reconcile/);
      configureComputeFunding(store, user, { enabled: false }, context());
      expect(() => assertComputeFundingAuthority(store, user, prepared.intent.id)).toThrow(/disabled/);
      expect(getComputeFundingPolicy(store, user).reserved0G).toBe("0.11");
    } finally { store.db.close(); }
  });
  it("settles only matching trusted receipts and charges actual gas once", () => {
    const { store, user } = setup();
    try {
      configureComputeFunding(store, user, policy(), context());
      const prepared = prepareComputeFunding(store, user, "confirmed", context());
      if (prepared.status !== "prepared") throw new Error("Missing intent");
      recordComputeFundingSubmission(store, user, prepared.intent.id, transactionHash);
      const result = { status: "confirmed" as const, transactionHash, chainId: 16602 as const, creditStatus: "awaiting-router-sync" as const, amountWei: prepared.intent.amountWei, gasPaidWei: parseEther("0.001").toString(), beneficiary: computeAccountAddress };
      expect(() => settleComputeFunding(store, user, prepared.intent.id, { ...result, beneficiary: operatingAddress })).toThrow(/receipt must match/);
      settleComputeFunding(store, user, prepared.intent.id, result);
      settleComputeFunding(store, user, prepared.intent.id, result);
      expect(getComputeFundingPolicy(store, user)).toMatchObject({ reserved0G: "0", spent0G: "0.101", available0G: "0.119" });
      expect(() => configureComputeFunding(store, user, { ...policy(), topUp0G: "0.01", maximumTotal0G: "0.1" }, context())).toThrow(/already spent/);
      expect(getComputeFundingPolicy(store, user).intents[0].evidence?.creditStatus).toBe("awaiting-router-sync");
      expect(prepareComputeFunding(store, user, "wait-for-sync", context())).toMatchObject({ status: "no-action", reason: expect.stringMatching(/awaiting a later Router balance/) });
      const credited = context();
      expect(prepareComputeFunding(store, user, "observe-credit", { ...credited, providerBalance: { ...credited.providerBalance, balanceNeurons: parseEther("0.1").toString() } })).toMatchObject({ status: "no-action" });
      expect(getComputeFundingPolicy(store, user).intents[0].evidence?.creditStatus).toBe("router-balance-observed");
    } finally { store.db.close(); }
  });
  it("uses only actual gas for a reverted deposit and enforces cumulative caps", () => {
    const { store, user } = setup();
    try {
      configureComputeFunding(store, user, { ...policy(), maximumTotal0G: "0.11" }, context());
      const prepared = prepareComputeFunding(store, user, "reverted", context());
      if (prepared.status !== "prepared") throw new Error("Missing intent");
      recordComputeFundingSubmission(store, user, prepared.intent.id, transactionHash);
      settleComputeFunding(store, user, prepared.intent.id, { status: "failed", transactionHash, chainId: 16602, creditStatus: "unconfirmed", amountWei: "0", gasPaidWei: parseEther("0.001").toString(), beneficiary: computeAccountAddress });
      expect(getComputeFundingPolicy(store, user)).toMatchObject({ spent0G: "0.001", reserved0G: "0" });
      expect(() => prepareComputeFunding(store, user, "next", context())).toThrow(/remaining native operating cap/);
    } finally { store.db.close(); }
  });
  it("releases a persisted candidate hash only when trusted preflight proves it was never submitted", () => {
    const { store, user } = setup();
    try {
      configureComputeFunding(store, user, policy(), context());
      const prepared = prepareComputeFunding(store, user, "preflight", context());
      if (prepared.status !== "prepared") throw new Error("Missing intent");
      recordComputeFundingSubmission(store, user, prepared.intent.id, transactionHash);
      expect(() => cancelComputeFunding(store, user, prepared.intent.id, { phase: "not-submitted", transactionHash: `0x${"5".repeat(64)}` })).toThrow(/Reconcile/);
      cancelComputeFunding(store, user, prepared.intent.id, { phase: "not-submitted", transactionHash });
      expect(getComputeFundingPolicy(store, user).reserved0G).toBe("0");
    } finally { store.db.close(); }
  });
});
