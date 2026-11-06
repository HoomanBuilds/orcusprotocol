import { createHash } from "node:crypto";
import type { User } from "@orcus/core";
import { engineConfig } from "@orcus/engine";
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, zeroAddress, type Hex } from "viem";
import { z } from "zod";
import { micros, usd } from "./budget";
import { serviceCreditTotals, servicePaymentMode } from "./service-credits";
import { ApiError } from "./errors";
import type { Store } from "./store";
import type { StoredRecord } from "./types";

export type ServicePaymentIntent = StoredRecord & {
  mode: "testnet"; testOnly: true; chainId: 11155111; token: string; payer: string; treasury: string;
  amountUsd: string; amountBaseUnits: string; creditsMicros: number; data: Hex; value: "0";
  notBefore: number; expiresAt: number; minimumBlock: string;
  status: "prepared" | "awaiting-wallet" | "submitted" | "credited" | "reverted" | "cancelled";
  transactionHash?: string; blockHash?: string; blockNumber?: string; logIndex?: string; creditedAt?: number;
};
const hash = z.string().regex(/^0x[\da-fA-F]{64}$/);
const createSchema = z.object({ amountUsd: z.string().max(20), requestId: z.string().min(1).max(150) }).strict();
const identity = (userId: string, requestId: string) => `service-payment:${createHash("sha256").update(JSON.stringify([userId, requestId])).digest("hex")}`;

function config() {
  const mode = servicePaymentMode(), { usdc: token, rpcUrl } = engineConfig().uniswap;
  let treasury: string | undefined;
  try { if (process.env.ORCUS_SERVICE_PAYMENT_TREASURY) { treasury = getAddress(process.env.ORCUS_SERVICE_PAYMENT_TREASURY); if (treasury === zeroAddress) throw new Error(); } }
  catch { throw new ApiError("SERVICE_PAYMENT_UNCONFIGURED", "Configure the testnet service payment treasury address.", 503); }
  return { mode, token: getAddress(token), rpcUrl, treasury, configured: mode === "testnet" && Boolean(treasury) };
}

async function rpc(method: string, params: unknown[] = []) {
  try {
    const response = await fetch(config().rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!response.ok) throw new Error();
    const text = await response.text(); if (text.length > 1_000_000) throw new Error();
    const body = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (body.error || body.result === undefined) throw new Error();
    return body.result;
  } catch { throw new ApiError("SERVICE_PAYMENT_PENDING", "Payment evidence is unavailable. Reconcile the same payment before sending another transfer.", 503); }
}

function intentFor(store: Store, user: User, intentId: string) {
  const intent = store.get<ServicePaymentIntent>(user.id, "service-payment", intentId);
  if (!intent) throw new ApiError("SERVICE_PAYMENT_NOT_FOUND", "This payment intent does not belong to the signed-in wallet.", 404);
  return intent;
}

export function servicePaymentSummary(store: Store, user: User) {
  let state: ReturnType<typeof config> | undefined;
  try { state = config(); } catch {}
  const totals = serviceCreditTotals(store, user.id);
  return {
    mode: state?.mode ?? "disabled", configured: state?.configured ?? false, testOnly: true, chainId: 11155111,
    token: state?.token, treasury: state?.treasury, confirmations: 2,
    credits: { paidUsd: usd(totals.paid), spentUsd: usd(totals.spent), reservedUsd: usd(totals.reserved), releasedUsd: usd(totals.released), remainingUsd: usd(totals.remaining), refundedUsd: "0.000000" },
    intents: store.list<ServicePaymentIntent>(user.id, "service-payment", 50),
    message: "Sepolia test USDC has no monetary value. Verified transfers grant test-only service credits, separate from trading capital and the expense cap. Released reservations are not token refunds. Live collection is disabled.",
  };
}

export async function createServicePayment(store: Store, user: User, value: unknown) {
  const input = createSchema.parse(value), cfg = config(), amount = micros(input.amountUsd), id = identity(user.id, input.requestId);
  if (!cfg.configured || !cfg.treasury) throw new ApiError("SERVICE_PAYMENT_UNCONFIGURED", "Testnet service payments are disabled or the treasury is unconfigured.", 503);
  if (amount < 10_000 || amount > 100_000_000) throw new ApiError("INVALID_AMOUNT", "A testnet service payment must be between 0.01 and 100 USDC.");
  if (getAddress(user.address) === cfg.treasury) throw new ApiError("SERVICE_PAYMENT_PAYER_INVALID", "The treasury cannot purchase its own service credits.", 403);
  const previous = store.get<ServicePaymentIntent>(user.id, "service-payment", id);
  if (previous) {
    if (previous.creditsMicros !== amount) throw new ApiError("SERVICE_PAYMENT_CONFLICT", "This payment reference already has a different immutable amount.", 409);
    return previous;
  }
  if (serviceCreditTotals(store, user.id).paid + amount > 100_000_000_000) throw new ApiError("SERVICE_PAYMENT_CAP", "The test-credit account reached its supported payment limit.", 409);
  const [chain, block, code, decimals] = await Promise.all([
    rpc("eth_chainId"), rpc("eth_getBlockByNumber", ["latest", false]), rpc("eth_getCode", [cfg.token, "latest"]),
    rpc("eth_call", [{ to: cfg.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }) }, "latest"]),
  ]);
  if (chain !== "0xaa36a7") throw new ApiError("SERVICE_PAYMENT_WRONG_NETWORK", "Service payments only support Ethereum Sepolia.", 503);
  if (typeof code !== "string" || !/^0x(?:[\da-fA-F]{2})+$/.test(code) || typeof decimals !== "string" || BigInt(decimals) !== 6n) throw new ApiError("SERVICE_PAYMENT_TOKEN_INVALID", "The configured testnet USDC contract or its six-decimal precision could not be verified.", 503);
  const head = z.object({ number: z.string().regex(/^0x[\da-fA-F]+$/), timestamp: z.string().regex(/^0x[\da-fA-F]+$/) }).parse(block);
  if (Math.abs(Number(BigInt(head.timestamp)) - Math.floor(Date.now() / 1000)) > 120) throw new ApiError("SERVICE_PAYMENT_STALE_NETWORK", "The payment network head is stale. Refresh before quoting a new payment.", 503);
  return store.db.transaction(() => {
    const existing = store.get<ServicePaymentIntent>(user.id, "service-payment", id);
    if (existing) { if (existing.creditsMicros !== amount) throw new ApiError("SERVICE_PAYMENT_CONFLICT", "This reference already has a different payment amount.", 409); return existing; }
    if (store.list<ServicePaymentIntent>(user.id, "service-payment", 500).some(intent => ["awaiting-wallet", "submitted"].includes(intent.status) || intent.status === "prepared" && intent.expiresAt > Date.now())) throw new ApiError("SERVICE_PAYMENT_PENDING", "Resolve or dismiss the existing payment before creating another.", 409);
    const now = Date.now();
    return store.put("service-payment", { id, userId: user.id, mode: "testnet", testOnly: true, chainId: 11155111, token: cfg.token, payer: getAddress(user.address), treasury: cfg.treasury!, amountUsd: usd(amount), amountBaseUnits: String(amount), creditsMicros: amount, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(cfg.treasury!), BigInt(amount)] }), value: "0", notBefore: Math.floor(now / 1000), expiresAt: now + 900_000, minimumBlock: (BigInt(head.number) + 1n).toString(), status: "prepared", createdAt: now, updatedAt: now } satisfies ServicePaymentIntent);
  }).immediate();
}

export function recordServicePaymentSubmission(store: Store, user: User, intentId: string, transactionHash?: string) {
  if (transactionHash) hash.parse(transactionHash);
  return store.db.transaction(() => {
    const intent = intentFor(store, user, intentId), cfg = config();
    if (intent.transactionHash && transactionHash && intent.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new ApiError("SERVICE_PAYMENT_CONFLICT", "Reconcile the previously recorded payment hash instead of replacing it.", 409);
    if (intent.status === "credited") return intent;
    if (!cfg.configured || cfg.treasury !== intent.treasury || cfg.token !== intent.token) throw new ApiError("SERVICE_PAYMENT_UNCONFIGURED", "The payment configuration changed. Do not sign the old quote.", 503);
    if (!transactionHash && (intent.status !== "prepared" || intent.expiresAt <= Date.now())) throw new ApiError("SERVICE_PAYMENT_EXPIRED", "This payment quote expired or already entered the wallet. Reconcile it before retrying.", 409);
    return store.update<ServicePaymentIntent>(user.id, "service-payment", intent.id, { status: transactionHash ? "submitted" : "awaiting-wallet", ...(transactionHash ? { transactionHash } : {}) });
  }).immediate();
}

export function cancelServicePayment(store: Store, user: User, intentId: string) {
  const intent = intentFor(store, user, intentId);
  if (["credited", "submitted", "reverted"].includes(intent.status) || intent.transactionHash) throw new ApiError("SERVICE_PAYMENT_PENDING", "A recorded payment must be reconciled rather than dismissed.", 409);
  return store.update<ServicePaymentIntent>(user.id, "service-payment", intent.id, { status: "cancelled" });
}

export async function reconcileServicePayment(store: Store, user: User, intentId: string, suppliedHash?: string) {
  const intent = intentFor(store, user, intentId), transactionHash = hash.parse(suppliedHash ?? intent.transactionHash);
  if (intent.transactionHash && intent.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new ApiError("SERVICE_PAYMENT_CONFLICT", "Use the payment hash already recorded for this intent.", 409);
  if (intent.status === "credited") return intent;
  if (await rpc("eth_chainId") !== "0xaa36a7") throw new ApiError("SERVICE_PAYMENT_WRONG_NETWORK", "The payment evidence is not from Ethereum Sepolia.", 503);
  const [transaction, receipt] = await Promise.all([rpc("eth_getTransactionByHash", [transactionHash]), rpc("eth_getTransactionReceipt", [transactionHash])]);
  if (!transaction || !receipt) throw new ApiError("SERVICE_PAYMENT_PENDING", "This payment has no confirmed receipt yet. Reconcile it without sending another transfer.", 409);
  const tx = z.object({ hash, from: z.string(), to: z.string(), chainId: z.literal("0xaa36a7"), value: z.string().regex(/^0x[\da-fA-F]+$/), input: z.string(), blockHash: hash, blockNumber: z.string().regex(/^0x[\da-fA-F]+$/) }).safeParse(transaction);
  const mined = z.object({ transactionHash: hash, blockHash: hash, blockNumber: z.string().regex(/^0x[\da-fA-F]+$/), status: z.enum(["0x0", "0x1"]), logs: z.array(z.unknown()) }).safeParse(receipt);
  if (!tx.success || !mined.success) throw new ApiError("SERVICE_PAYMENT_EVIDENCE_INVALID", "The payment transaction or receipt is malformed or from another network.", 409);
  if (tx.data.hash.toLowerCase() !== transactionHash.toLowerCase() || mined.data.transactionHash.toLowerCase() !== transactionHash.toLowerCase() || tx.data.blockHash !== mined.data.blockHash || tx.data.blockNumber !== mined.data.blockNumber || getAddress(tx.data.from) !== intent.payer || getAddress(tx.data.to) !== intent.token || BigInt(tx.data.value) !== 0n || tx.data.input.toLowerCase() !== intent.data.toLowerCase()) throw new ApiError("SERVICE_PAYMENT_EVIDENCE_INVALID", "The transfer must match the exact quoted owner, token, treasury and amount with no native value.", 409);
  if (mined.data.status === "0x0") return store.update<ServicePaymentIntent>(user.id, "service-payment", intent.id, { status: "reverted", transactionHash });
  const call = decodeFunctionData({ abi: erc20Abi, data: tx.data.input as Hex });
  if (call.functionName !== "transfer" || getAddress(call.args[0]) !== intent.treasury || call.args[1] !== BigInt(intent.amountBaseUnits)) throw new ApiError("SERVICE_PAYMENT_EVIDENCE_INVALID", "This is not the quoted USDC transfer.", 409);
  const [block, head] = await Promise.all([rpc("eth_getBlockByNumber", [mined.data.blockNumber, false]), rpc("eth_blockNumber")]);
  const canonical = z.object({ hash, number: z.string().regex(/^0x[\da-fA-F]+$/), timestamp: z.string().regex(/^0x[\da-fA-F]+$/) }).parse(block);
  if (canonical.hash !== mined.data.blockHash || canonical.number !== mined.data.blockNumber || BigInt(canonical.number) < BigInt(intent.minimumBlock) || BigInt(canonical.timestamp) < BigInt(intent.notBefore)) throw new ApiError("SERVICE_PAYMENT_WINDOW_INVALID", "The payment predates this intent or its receipt is no longer canonical.", 409);
  if (typeof head !== "string" || !/^0x[\da-fA-F]+$/.test(head) || BigInt(head) < BigInt(canonical.number) + 1n) throw new ApiError("SERVICE_PAYMENT_PENDING", "Wait for two payment confirmations, then reconcile this same transaction.", 409);
  const matches = mined.data.logs.flatMap(value => {
    const log = z.object({ address: z.string(), topics: z.array(z.string()), data: z.string(), logIndex: z.string().regex(/^0x[\da-fA-F]+$/), transactionHash: hash, blockHash: hash, removed: z.boolean().optional() }).safeParse(value);
    if (!log.success || log.data.removed || log.data.address.toLowerCase() !== intent.token.toLowerCase() || log.data.transactionHash.toLowerCase() !== transactionHash.toLowerCase() || log.data.blockHash !== canonical.hash) return [];
    try { const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: log.data.topics as [Hex, ...Hex[]], data: log.data.data as Hex }); return getAddress(event.args.from) === intent.payer && getAddress(event.args.to) === intent.treasury && event.args.value === BigInt(intent.amountBaseUnits) ? [log.data] : []; } catch { return []; }
  });
  if (matches.length !== 1) throw new ApiError("SERVICE_PAYMENT_EVIDENCE_INVALID", "One exact USDC Transfer event is required before credits are added.", 409);
  return store.db.transaction(() => {
    const current = intentFor(store, user, intentId);
    if (current.status === "credited") return current;
    if (current.transactionHash && current.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new ApiError("SERVICE_PAYMENT_CONFLICT", "The payment hash changed while its evidence was being checked.", 409);
    const proofId = `service-payment-proof:${intent.chainId}:${transactionHash.toLowerCase()}:${BigInt(matches[0].logIndex)}`, existing = store.db.prepare("SELECT body FROM records WHERE id=?").get(proofId);
    if (existing) throw new ApiError("SERVICE_PAYMENT_REPLAY", "This payment event already granted credits and cannot be claimed again.", 409);
    if (serviceCreditTotals(store, user.id).paid + intent.creditsMicros > 100_000_000_000) throw new ApiError("SERVICE_PAYMENT_CAP", "The test-credit account reached its supported payment limit.", 409);
    const now = Date.now();
    store.put("service-payment-proof", { id: proofId, userId: user.id, intentId, createdAt: now, updatedAt: now });
    return store.update<ServicePaymentIntent>(user.id, "service-payment", intentId, { status: "credited", transactionHash, blockHash: canonical.hash, blockNumber: BigInt(canonical.number).toString(), logIndex: BigInt(matches[0].logIndex).toString(), creditedAt: now });
  }).immediate();
}
