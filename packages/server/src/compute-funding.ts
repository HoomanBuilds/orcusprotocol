import { createHash } from "node:crypto";
import { formatEther, getAddress, isAddressEqual, parseEther } from "viem";
import { z } from "zod";
import type { User } from "@orcus/core";
import { buildComputeFunding, nativeAmount, type ComputeFundingIntent, type ComputeFundingResult } from "@orcus/engine/budget";
import { ApiError } from "./errors";
import type { Store } from "./store";

const amount = z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,18})?$/);
const address = z.string().regex(/^0x[\da-fA-F]{40}$/);
const policyInput = z.object({ enabled: z.literal(true), chainId: z.literal(16602), currency: z.literal("0g"), computeAccountAddress: address, topUp0G: amount, maximumTotal0G: amount, lowBalance0G: amount, maxGas0G: amount, expiresAt: z.number().int().positive() }).strict();
type FundingPolicy = Omit<z.infer<typeof policyInput>, "enabled"> & { enabled: boolean; id: string; userId: string; ownerAddress: string; payerAddress: string; revision: number; createdAt: number; updatedAt: number };
type FundingRecord = ComputeFundingIntent & { status: "prepared" | "submitting" | "submitted-unknown" | "confirmed" | "failed" | "cancelled"; updatedAt: number; providerBalanceBeforeBaseUnits: string; transactionHash?: string; evidence?: ComputeFundingResult; spentWei?: string; creditObservedAt?: number; reason?: string };
type PreparedFunding = { status: "prepared"; intent: FundingRecord } | { status: "no-action"; reason: string };
type FundingContext = { operatingAddress: string; providerBalance: unknown; paymentVaultBalance?: unknown };
const policyId = (user: User) => `compute-policy:${user.id}`;
const loadPolicy = (store: Store, user: User) => store.get<FundingPolicy>(user.id, "compute-funding-policy", policyId(user));
const loadRecords = (store: Store, user: User): FundingRecord[] => (store.db.prepare("SELECT body FROM records WHERE user_id=? AND kind='compute-funding' ORDER BY created_at DESC,id").all(user.id) as { body: string }[]).map(row => JSON.parse(row.body));
const pending = (record: FundingRecord) => ["prepared", "submitting", "submitted-unknown"].includes(record.status);
function totals(records: FundingRecord[]) { return records.reduce((result, record) => ({ spent: result.spent + BigInt(record.spentWei ?? "0"), reserved: result.reserved + (pending(record) ? BigInt(record.amountWei) + BigInt(record.maxGasWei) : 0n) }), { spent: 0n, reserved: 0n }); }

function verifiedBalance(value: unknown, accountAddress: string): bigint {
  const parsed = z.object({ status: z.literal("verified"), currency: z.literal("0g"), accountAddress: address, observedAt: z.number().int().positive(), balanceNeurons: z.string().regex(/^\d{1,80}$/).optional(), balanceBaseUnits: z.string().regex(/^\d{1,80}$/).optional() }).safeParse(value);
  if (!parsed.success || !isAddressEqual(getAddress(parsed.data.accountAddress), getAddress(accountAddress)) || Math.abs(Date.now() - parsed.data.observedAt) > 60_000) throw new ApiError("COMPUTE_ACCOUNT_UNVERIFIED", "Funding requires a fresh Router balance for the exact approved 0G-mode account. USD billing and inference-only keys cannot authorize native deposits.", 409);
  const balance = parsed.data.balanceBaseUnits ?? parsed.data.balanceNeurons;
  if (balance === undefined) throw new ApiError("COMPUTE_ACCOUNT_UNVERIFIED", "The provider must report its native account balance before replenishment.", 409);
  return BigInt(balance);
}

function verifiedVaultBalance(value: unknown, accountAddress: string): bigint {
  const parsed = z.object({ source: z.literal("payment-vault"), chainId: z.literal(16602), currency: z.literal("0g"), accountAddress: address, balanceNeurons: z.string().regex(/^\d{1,80}$/), observedAt: z.number().int().positive() }).safeParse(value);
  if (!parsed.success || !isAddressEqual(getAddress(parsed.data.accountAddress), getAddress(accountAddress)) || Math.abs(Date.now() - parsed.data.observedAt) > 60_000) throw new ApiError("COMPUTE_VAULT_UNVERIFIED", "Read the exact Galileo PaymentVault account before replenishing. Router balances omit funds waiting for its next payment-worker batch.", 409);
  return BigInt(parsed.data.balanceNeurons);
}

function requirePolicy(store: Store, user: User): FundingPolicy {
  const policy = loadPolicy(store, user);
  const enabled = store.db.prepare("SELECT auto_replenish FROM budgets WHERE user_id=?").get(user.id) as { auto_replenish: number } | undefined;
  if (!policy?.enabled || !enabled?.auto_replenish || policy.expiresAt <= Date.now() || !isAddressEqual(getAddress(policy.ownerAddress), getAddress(user.address))) throw new ApiError("COMPUTE_FUNDING_DISABLED", "Compute replenishment is disabled, expired, or not owner-authorized.", 409);
  return policy;
}

function requiredRecord(store: Store, user: User, intentId: string): FundingRecord {
  const record = store.get<FundingRecord>(user.id, "compute-funding", intentId);
  if (!record) throw new ApiError("NOT_FOUND", "The compute funding intent does not exist.", 404);
  return record;
}

export function getComputeFundingPolicy(store: Store, user: User) {
  const policy = loadPolicy(store, user), records = loadRecords(store, user), { spent, reserved } = totals(records);
  const cap = policy ? nativeAmount(policy.maximumTotal0G) : 0n;
  return { policy: policy ?? null, spent0G: formatEther(spent), reserved0G: formatEther(reserved), available0G: formatEther(cap > spent + reserved ? cap - spent - reserved : 0n), intents: records.slice(0, 50), status: policy?.enabled && policy.expiresAt > Date.now() ? "authorized" : "disabled", scope: "configured-provider-account", warning: "A deposit funds the named Router account, which may be shared by the operator. Vault confirmation is not proof that Router credits have synchronized. Native operating funds never come from trading principal." };
}

export function configureComputeFunding(store: Store, user: User, value: unknown, context: FundingContext) {
  return store.db.transaction(() => {
    const previous = loadPolicy(store, user), now = Date.now();
    if (z.object({ enabled: z.literal(false) }).strict().safeParse(value).success) {
      if (previous) store.put("compute-funding-policy", { ...previous, enabled: false, revision: previous.revision + 1, updatedAt: now });
      store.db.prepare("UPDATE budgets SET auto_replenish=0 WHERE user_id=?").run(user.id);
      return getComputeFundingPolicy(store, user);
    }
    const input = policyInput.parse(value), payer = getAddress(context.operatingAddress), account = getAddress(input.computeAccountAddress);
    if (isAddressEqual(payer, getAddress(user.address))) throw new ApiError("OPERATING_WALLET_REQUIRED", "Use a separate agent operating wallet for compute funding.", 409);
    verifiedBalance(context.providerBalance, account);
    const topUp = nativeAmount(input.topUp0G), cap = nativeAmount(input.maximumTotal0G), gas = nativeAmount(input.maxGas0G);
    if (topUp + gas > cap) throw new ApiError("COMPUTE_FUNDING_CAP", "The native funding cap must cover one deposit and its maximum gas cost.", 409);
    if (input.expiresAt <= now || input.expiresAt > now + 30 * 86_400_000) throw new ApiError("INVALID_FUNDING_EXPIRY", "The owner authorization must expire within thirty days.", 409);
    const current = totals(loadRecords(store, user));
    if (cap < current.spent + current.reserved) throw new ApiError("COMPUTE_FUNDING_CAP", "The cap cannot be below already spent or reserved operating funds.", 409);
    const policy: FundingPolicy = { ...input, computeAccountAddress: account, id: policyId(user), userId: user.id, ownerAddress: getAddress(user.address), payerAddress: payer, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
    store.put("compute-funding-policy", policy);
    store.db.prepare("UPDATE budgets SET auto_replenish=1 WHERE user_id=?").run(user.id);
    return getComputeFundingPolicy(store, user);
  })();
}

export function prepareComputeFunding(store: Store, user: User, requestId: string, context: FundingContext): PreparedFunding {
  if (!/^[\w:.-]{1,150}$/.test(requestId)) throw new ApiError("INVALID_REQUEST_ID", "A bounded idempotency reference is required.");
  return store.db.transaction((): PreparedFunding => {
    const policy = requirePolicy(store, user), now = Date.now();
    if (!isAddressEqual(getAddress(context.operatingAddress), getAddress(policy.payerAddress))) throw new ApiError("FUNDING_PAYER_MISMATCH", "The owner must authorize this operating wallet before funding.", 409);
    const balance = verifiedBalance(context.providerBalance, policy.computeAccountAddress);
    const vaultBalance = verifiedVaultBalance(context.paymentVaultBalance, policy.computeAccountAddress);
    for (const record of loadRecords(store, user)) if (record.status === "prepared" && !record.transactionHash && (record.expiresAt <= now || record.policyRevision !== policy.revision)) store.update<FundingRecord>(user.id, "compute-funding", record.id, { status: "cancelled", reason: "Prepared deposit expired or its policy changed before submission." });
    const intentId = `compute-funding:${createHash("sha256").update(`${user.id}:${requestId}`).digest("hex")}`;
    const existing = store.get<FundingRecord>(user.id, "compute-funding", intentId);
    if (existing) return existing.status === "prepared" ? { status: "prepared", intent: existing } : { status: "no-action", reason: `This request is already ${existing.status}.` };
    let records = loadRecords(store, user);
    if (records.some(pending)) return { status: "no-action", reason: "Reconcile the previous deposit before scheduling another." };
    for (const record of records) {
      if (record.status !== "confirmed" || record.creditObservedAt) continue;
      if (balance <= BigInt(record.providerBalanceBeforeBaseUnits)) return { status: "no-action", reason: "A confirmed deposit is awaiting a later Router balance increase. Reconcile its credit synchronization before funding again." };
      store.update<FundingRecord>(user.id, "compute-funding", record.id, { creditObservedAt: now, evidence: record.evidence ? { ...record.evidence, creditStatus: "router-balance-observed" } : undefined });
    }
    if (balance + vaultBalance > parseEther(policy.lowBalance0G)) return { status: "no-action", reason: "The provider account or its unspent PaymentVault funds exceed the approved low-balance threshold." };
    records = loadRecords(store, user);
    const { spent, reserved } = totals(records), reserve = nativeAmount(policy.topUp0G) + nativeAmount(policy.maxGas0G);
    if (spent + reserved + reserve > nativeAmount(policy.maximumTotal0G)) throw new ApiError("COMPUTE_FUNDING_CAP", "The remaining native operating cap cannot cover this deposit and its gas limit.", 402);
    const intent: FundingRecord = { ...buildComputeFunding({ id: intentId, userId: user.id, ownerAddress: user.address, payerAddress: policy.payerAddress, computeAccountAddress: policy.computeAccountAddress, topUp0G: policy.topUp0G, maxGas0G: policy.maxGas0G, expiresAt: Math.min(now + 300_000, policy.expiresAt), policyRevision: policy.revision }), status: "prepared", providerBalanceBeforeBaseUnits: balance.toString(), updatedAt: now };
    store.put("compute-funding", intent);
    return { status: "prepared", intent };
  })();
}

export function assertComputeFundingAuthority(store: Store, user: User, intentId: string) {
  const policy = requirePolicy(store, user), record = requiredRecord(store, user, intentId);
  if (!["prepared", "submitting"].includes(record.status) || record.expiresAt <= Date.now() || record.policyRevision !== policy.revision || !isAddressEqual(getAddress(record.payerAddress), getAddress(policy.payerAddress)) || !isAddressEqual(getAddress(record.computeAccountAddress), getAddress(policy.computeAccountAddress))) throw new ApiError("COMPUTE_FUNDING_REVOKED", "This deposit expired or its owner authorization changed.", 409);
  return record;
}

export function recordComputeFundingSubmission(store: Store, user: User, intentId: string, transactionHash: string) {
  return store.db.transaction(() => {
    if (!/^0x[\da-fA-F]{64}$/.test(transactionHash)) throw new ApiError("INVALID_FUNDING_HASH", "A signed deposit hash is required.");
    const record = assertComputeFundingAuthority(store, user, intentId);
    if (record.transactionHash && record.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new ApiError("FUNDING_HASH_CHANGED", "A prepared deposit cannot be replaced with another transaction.", 409);
    return store.update<FundingRecord>(user.id, "compute-funding", intentId, { status: "submitting", transactionHash });
  })();
}

export function cancelComputeFunding(store: Store, user: User, intentId: string, preflightFailure?: { phase: "not-submitted"; transactionHash?: string }) {
  return store.db.transaction(() => {
    const record = requiredRecord(store, user, intentId);
    const knownNotSubmitted = preflightFailure?.phase === "not-submitted" && record.status === "submitting" && record.transactionHash && preflightFailure.transactionHash?.toLowerCase() === record.transactionHash.toLowerCase();
    if (!knownNotSubmitted && (record.status !== "prepared" || record.transactionHash)) throw new ApiError("FUNDING_SUBMISSION_UNCERTAIN", "Reconcile the signed transaction before releasing its reservation.", 409);
    return store.update<FundingRecord>(user.id, "compute-funding", intentId, { status: "cancelled", reason: "Cancelled before transaction submission." });
  })();
}

export function settleComputeFunding(store: Store, user: User, intentId: string, evidence: ComputeFundingResult) {
  return store.db.transaction(() => {
    const record = requiredRecord(store, user, intentId);
    if (!record.transactionHash || record.transactionHash.toLowerCase() !== evidence.transactionHash.toLowerCase() || evidence.chainId !== record.chainId) throw new ApiError("FUNDING_EVIDENCE_MISMATCH", "Only the recorded, chain-verified deposit can settle this reservation.", 409);
    if (["confirmed", "failed", "cancelled"].includes(record.status)) return record;
    if (evidence.status === "submitted-unknown") return store.update<FundingRecord>(user.id, "compute-funding", intentId, { status: "submitted-unknown", evidence });
    const amountWei = evidence.status === "confirmed" ? record.amountWei : "0";
    if (evidence.amountWei !== amountWei || !evidence.beneficiary || !isAddressEqual(getAddress(evidence.beneficiary), getAddress(record.computeAccountAddress)) || !evidence.gasPaidWei || !/^\d{1,80}$/.test(evidence.gasPaidWei) || BigInt(evidence.gasPaidWei) > BigInt(record.maxGasWei)) throw new ApiError("FUNDING_EVIDENCE_MISMATCH", "The receipt must match the approved account, deposit amount, and network fee bound.", 409);
    return store.update<FundingRecord>(user.id, "compute-funding", intentId, { status: evidence.status, evidence, spentWei: (BigInt(amountWei) + BigInt(evidence.gasPaidWei)).toString() });
  })();
}
