import { createHash } from "node:crypto";
import { encodeCallDataEpV07, KernelV3_1AccountAbi } from "@zerodev/sdk";
import { createOwnerKernel, entryPoint, type KernelGasSponsorship } from "@orcus/wallets/kernel";
import { assertSponsoredOperation } from "@orcus/wallets/gas";
import { assertKernelPolicyCompatible, inspectPreparedSwap } from "@orcus/wallets/preflight";
import { decodeFunctionData, encodeFunctionData, getAddress, parseEther, type Hex } from "viem";
import { formatUserOperationRequest, getUserOperationHash, type UserOperation } from "viem/account-abstraction";
import type { PreparedAction, User } from "@orcus/core";
import { z } from "zod";
import { ApiError } from "./errors";
import type { Store } from "./store";
import type { StoredAccount, StoredAction, StoredAgent, StoredPermission, StoredRecord } from "./types";

const address = z.string().regex(/^0x[\da-fA-F]{40}$/), bytes = z.string().max(200_000).regex(/^0x(?:[\da-fA-F]{2})*$/), quantity = z.string().max(34).regex(/^0x[\da-fA-F]+$/);
const operationSchema = z.object({ sender: address, nonce: z.string().max(66).regex(/^0x[\da-fA-F]+$/), callData: bytes, factory: address.optional(), factoryData: bytes.optional(), callGasLimit: quantity.optional(), verificationGasLimit: quantity.optional(), preVerificationGas: quantity.optional(), maxFeePerGas: quantity.optional(), maxPriorityFeePerGas: quantity.optional(), paymaster: address.optional(), paymasterData: bytes.optional(), paymasterVerificationGasLimit: quantity.optional(), paymasterPostOpGasLimit: quantity.optional(), signature: bytes.optional() }).strict();
const responseSchema = z.object({ paymaster: address, paymasterData: bytes, callGasLimit: quantity, verificationGasLimit: quantity, preVerificationGas: quantity, paymasterVerificationGasLimit: quantity, paymasterPostOpGasLimit: quantity, maxFeePerGas: quantity.optional(), maxPriorityFeePerGas: quantity.optional() }).strict();
const requestSchema = z.object({ chainId: z.literal(11155111), entryPointAddress: address, userOp: operationSchema, shouldOverrideFee: z.literal(false).optional(), shouldConsume: z.boolean().optional() }).strict();
type Scope = { actionId?: string; accountAddress?: string; purpose?: string; agent?: boolean };
type Operation = z.infer<typeof operationSchema>;
type Grant = StoredRecord & { fingerprint: string; operation: Operation; scope: Scope; expiresAt: number; reserveWei: string; stage: "stub" | "final"; status: "reserved" | "submitted" | "settled"; actualGasCostWei?: string; userOperationHash?: string };
const gasFields = ["callGasLimit", "verificationGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "maxFeePerGas", "maxPriorityFeePerGas"] as const;

function config() {
  const value = (name: string, fallback: string) => { const text = process.env[name] ?? fallback; if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,18})?$/.test(text) || parseEther(text) <= 0n) throw new ApiError("SPONSORSHIP_CONFIG_INVALID", "The gas sponsorship caps must be positive exact ETH amounts.", 503); return parseEther(text).toString(); };
  const perOperation = value("ZERODEV_SPONSOR_MAX_OPERATION_ETH", "0.003"), daily = value("ZERODEV_SPONSOR_USER_DAILY_ETH", "0.02"), projectDaily = value("ZERODEV_SPONSOR_PROJECT_DAILY_ETH", "0.2"), count = process.env.ZERODEV_SPONSOR_USER_DAILY_OPERATIONS ?? "20";
  if (!/^[1-9]\d{0,3}$/.test(count) || Number(count) > 1000) throw new ApiError("SPONSORSHIP_CONFIG_INVALID", "The daily sponsorship operation count must be between one and one thousand.", 503);
  const upstream = process.env.ZERODEV_PAYMASTER_RPC_URL;
  if (upstream) { try { const url = new URL(upstream); if (url.protocol !== "https:" || url.hostname !== "rpc.zerodev.app" || url.username || url.password || url.port && url.port !== "443") throw new Error(); } catch { throw new ApiError("SPONSORSHIP_CONFIG_INVALID", "Use the server-only HTTPS ZeroDev paymaster endpoint.", 503); } }
  return { upstream, perOperation, daily, projectDaily, count: Number(count), configured: Boolean(upstream && process.env.ZERODEV_RPC_URL) };
}

export function sponsorshipSummary() {
  try { const cfg = config(); return { required: true, configured: cfg.configured, status: cfg.configured ? "configured" : "unconfigured", paymasterUrl: "/api/paymaster", maxOperationGasWei: cfg.perOperation, dailyUserGasWei: cfg.daily, chainId: 11155111, message: "Provider configuration is not proof of funded sponsorship. Every operation is checked before signing; no paid-gas fallback is automatic." }; }
  catch { return { required: true, configured: false, status: "unconfigured", paymasterUrl: "/api/paymaster", maxOperationGasWei: "0", dailyUserGasWei: "0", chainId: 11155111, message: "Gas sponsorship configuration is invalid. No sponsored operation can be submitted." }; }
}

function grantId(userId: string, operation: Operation) {
  return `gas-sponsorship:${createHash("sha256").update(JSON.stringify([userId, operation.sender.toLowerCase(), BigInt(operation.nonce).toString(), operation.callData.toLowerCase(), operation.factory?.toLowerCase(), operation.factoryData?.toLowerCase()])).digest("hex")}`;
}
const fingerprint = (operation: Operation) => createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(operation).filter(([key, value]) => key !== "signature" && value !== undefined).map(([key, value]) => [key, key === "nonce" || gasFields.includes(key as typeof gasFields[number]) ? BigInt(value!).toString() : value!.toLowerCase()]).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");

async function validateScope(store: Store, user: User, scope: Scope, operation: Operation) {
  let action: StoredAction | undefined;
  if (scope.actionId) action = store.get<StoredAction>(user.id, "action", scope.actionId);
  const account = action ? store.get<StoredAccount>(user.id, "account", action.accountId!) : store.list<StoredAccount>(user.id, "account").find(item => item.address.toLowerCase() === scope.accountAddress?.toLowerCase());
  if (!account || account.venue !== "uniswap" || account.chainId !== 11155111 || !account.smartAccountAddress || getAddress(account.ownerAddress) !== getAddress(user.address) || getAddress(account.address) !== getAddress(operation.sender) || account.status === "unsupported") throw new ApiError("SPONSORSHIP_ACCOUNT_MISMATCH", "Sponsorship is limited to this owner's registered Sepolia Kernel account.", 403);
  if (scope.actionId) {
    if (!action || !["prepared", "awaiting-approval", "submitting"].includes(action.status) || action.expiresAt <= Date.now() || action.controlRevision !== account.controlRevision) throw new ApiError("SPONSORSHIP_ACTION_STALE", "Prepare a fresh action for this account before requesting sponsored gas.", 409);
    inspectPreparedSwap(action.prepared);
    const expected = await encodeCallDataEpV07(action.prepared.transactions!.map(tx => ({ to: getAddress(tx.to), data: tx.data as Hex, value: BigInt(tx.value) })));
    if (expected.toLowerCase() !== operation.callData.toLowerCase()) throw new ApiError("SPONSORSHIP_CALL_MISMATCH", "The operation does not match the exact reviewed swap calls.", 403);
    if (scope.agent) {
      const agent = store.list<StoredAgent>(user.id, "agent")[0], permission = store.list<StoredPermission>(user.id, "permission").find(item => item.accountId === account.id && item.status === "active" && item.expiresAt > Date.now() && item.controlRevision === account.controlRevision);
      if (!agent || agent.paused || agent.controlRevision !== action.agentRevision || !permission?.policy || account.status !== "authorized") throw new ApiError("SPONSORSHIP_AUTHORITY_CHANGED", "The delegated account authority changed before sponsorship.", 409);
      assertKernelPolicyCompatible(action.prepared, permission.policy);
    }
  } else {
    if (scope.purpose !== "permission-management") throw new ApiError("SPONSORSHIP_SCOPE_REQUIRED", "A reviewed trade or explicit permission recovery scope is required.", 403);
    const decoded = decodeFunctionData({ abi: KernelV3_1AccountAbi, data: operation.callData as Hex });
    if (decoded.functionName === "invalidateNonce") { if (decoded.args[0] <= 0 || decoded.args[0] > 0xffffffff) throw new ApiError("SPONSORSHIP_CALL_MISMATCH", "Invalid permission nonce floor.", 403); }
    else if (decoded.functionName === "uninstallValidation") { if (!decoded.args[0].startsWith("0x02") || decoded.args[2] !== "0x") throw new ApiError("SPONSORSHIP_CALL_MISMATCH", "Only permission-validator removal is sponsored.", 403); }
    else throw new ApiError("SPONSORSHIP_CALL_MISMATCH", "Arbitrary account management and self-execution are not sponsored.", 403);
    if (encodeFunctionData({ abi: KernelV3_1AccountAbi, functionName: decoded.functionName, args: decoded.args as never }).toLowerCase() !== operation.callData.toLowerCase()) throw new ApiError("SPONSORSHIP_CALL_MISMATCH", "Noncanonical account management data is not sponsored.", 403);
  }
  const owner = await createOwnerKernel({ rpcUrl: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com", bundlerUrl: process.env.ZERODEV_RPC_URL! }, getAddress(user.address));
  if (getAddress(owner.account.address) !== getAddress(account.address)) throw new ApiError("SPONSORSHIP_OWNER_MISMATCH", "This Kernel account is not derived from the signed-in owner.", 403);
  const factory = await owner.account.getFactoryArgs();
  if ((operation.factory ?? "").toLowerCase() !== (factory.factory ?? "").toLowerCase() || (operation.factoryData ?? "").toLowerCase() !== (factory.factoryData ?? "").toLowerCase()) throw new ApiError("SPONSORSHIP_FACTORY_MISMATCH", "Account deployment data must match the owner's exact Kernel factory.", 403);
}

function reserve(store: Store, user: User, scope: Scope, operation: Operation, costWei: bigint, stage: "stub" | "final") {
  return store.db.transaction(() => {
    const cfg = config(), id = grantId(user.id, operation), previous = store.get<Grant>(user.id, "gas-sponsorship", id), start = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    if (previous && BigInt(previous.reserveWei) > costWei) costWei = BigInt(previous.reserveWei);
    const rows = (store.db.prepare("SELECT body FROM records WHERE kind='gas-sponsorship'").all() as { body: string }[]).map(row => JSON.parse(row.body) as Grant);
    let total = costWei, projectTotal = costWei, count = previous && previous.createdAt >= start ? 0 : 1;
    for (const row of rows) { if (row.id === id) continue; const cost = row.status !== "settled" ? BigInt(row.reserveWei) : row.updatedAt >= start ? BigInt(row.actualGasCostWei ?? row.reserveWei) : 0n; projectTotal += cost; if (row.userId === user.id) { total += cost; if (row.createdAt >= start) count++; } }
    if (previous?.status === "settled" || previous?.status === "submitted") throw new ApiError("SPONSORSHIP_ALREADY_SUBMITTED", "Reconcile this operation before requesting another gas authorization.", 409);
    if (total > BigInt(cfg.daily) || count > cfg.count) throw new ApiError("SPONSORSHIP_USER_CAP", "This user's daily sponsorship allowance is exhausted or held by unresolved operations.", 402);
    if (projectTotal > BigInt(cfg.projectDaily)) throw new ApiError("SPONSORSHIP_PROJECT_CAP", "The shared daily gas sponsorship cap is exhausted or reserved by unresolved operations.", 402);
    const now = Date.now();
    return store.put("gas-sponsorship", { id, userId: user.id, createdAt: previous?.createdAt ?? now, updatedAt: now, fingerprint: fingerprint(operation), operation, scope, expiresAt: now + 120_000, reserveWei: costWei.toString(), stage, status: "reserved" } satisfies Grant);
  }).immediate();
}

export async function sponsorKernelOperation(store: Store, user: User, scope: Scope, value: unknown) {
  const cfg = config();
  if (!cfg.configured) throw new ApiError("SPONSORSHIP_UNCONFIGURED", "A funded, policy-enabled gas sponsor is not configured. No operation was submitted.", 503);
  const input = requestSchema.parse(value);
  if (getAddress(input.entryPointAddress) !== getAddress(entryPoint.address)) throw new ApiError("SPONSORSHIP_ENTRYPOINT_MISMATCH", "Only the configured EntryPoint v0.7 is supported.", 403);
  await validateScope(store, user, scope, input.userOp);
  let response: Response;
  try { response = await fetch(cfg.upstream!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "zd_sponsorUserOperation", params: [{ ...input, shouldOverrideFee: false, shouldConsume: input.shouldConsume ?? true }] }), signal: AbortSignal.timeout(30_000), redirect: "error" }); }
  catch { throw new ApiError("SPONSORSHIP_UNAVAILABLE", "The gas sponsor could not be reached. No paid-gas fallback was used.", 503); }
  if (!response.ok) throw new ApiError("SPONSORSHIP_REJECTED", "The gas sponsor did not approve this request. No paid-gas fallback was used.", 503);
  let raw: unknown;
  try { const text = await response.text(); if (text.length > 100_000) throw new Error(); raw = JSON.parse(text); } catch { throw new ApiError("SPONSORSHIP_REJECTED", "The gas sponsor returned an invalid response.", 502); }
  const parsed = responseSchema.safeParse((raw as { result?: unknown })?.result);
  if (!parsed.success) throw new ApiError("SPONSORSHIP_REJECTED", "The gas sponsor returned no valid bounded approval.", 502);
  const operation = operationSchema.parse({ ...input.userOp, ...parsed.data });
  const cost = assertSponsoredOperation(operation, cfg.perOperation);
  await validateScope(store, user, scope, operation);
  reserve(store, user, scope, operation, cost, input.shouldConsume === false ? "stub" : "final");
  return parsed.data;
}

export function createSessionSponsorship(store: Store, user: User, prepared: PreparedAction): KernelGasSponsorship {
  let cfg: ReturnType<typeof config>;
  try { cfg = config(); if (!cfg.configured) throw new ApiError("SPONSORSHIP_UNCONFIGURED", "Agent swaps require configured sponsored gas. Nothing was submitted.", 503); }
  catch (error) { throw Object.assign(error as Error, { phase: "not-submitted" }); }
  const sponsor = (consume: boolean): KernelGasSponsorship["getPaymasterData"] => async input => {
    const userOp = JSON.parse(JSON.stringify(formatUserOperationRequest(input as unknown as UserOperation)));
    const result = await sponsorKernelOperation(store, user, { actionId: prepared.id, agent: true }, { chainId: 11155111, entryPointAddress: entryPoint.address, userOp, shouldOverrideFee: false, shouldConsume: consume });
    return { ...result, ...Object.fromEntries(gasFields.flatMap(key => result[key] === undefined ? [] : [[key, BigInt(result[key]!)]])) } as unknown as Awaited<ReturnType<KernelGasSponsorship["getPaymasterData"]>>;
  };
  return { maxOperationGasWei: cfg.perOperation, getPaymasterData: sponsor(true), getPaymasterStubData: sponsor(false), onSignedOperation: async (operation, hash) => { await noteSponsoredBroadcast(store, user, operation, hash, false); }, onReceipt: receipt => { settleSponsoredReceipt(store, user, receipt); } };
}

export async function validateSponsoredBroadcast(store: Store, user: User, value: unknown) {
  const operation = operationSchema.parse(value), cfg = config();
  if (!operation.signature || operation.signature === "0x") throw new ApiError("SPONSORSHIP_SIGNATURE_REQUIRED", "Sign the exact sponsored operation before submitting it.", 403);
  if (!cfg.configured) throw new ApiError("SPONSORSHIP_UNCONFIGURED", "Gas sponsorship is unavailable. No operation was submitted.", 503);
  assertSponsoredOperation(operation, cfg.perOperation);
  const grant = store.get<Grant>(user.id, "gas-sponsorship", grantId(user.id, operation));
  if (!grant || grant.fingerprint !== fingerprint(operation) || grant.stage !== "final" || grant.status === "settled" || grant.expiresAt <= Date.now()) throw new ApiError("SPONSORSHIP_GRANT_MISMATCH", "This signed operation does not match a fresh server-issued gas approval.", 403);
  await validateScope(store, user, grant.scope, operation);
  return grant;
}

export function sponsoredOperationHash(value: unknown) {
  const operation = operationSchema.parse(value);
  const numeric = Object.fromEntries(["nonce", ...gasFields].flatMap(key => operation[key as keyof Operation] === undefined ? [] : [[key, BigInt(operation[key as keyof Operation]!)] ]));
  return getUserOperationHash({ userOperation: { ...operation, ...numeric } as unknown as UserOperation<"0.7">, entryPointAddress: entryPoint.address, entryPointVersion: "0.7", chainId: 11155111 });
}

export async function noteSponsoredBroadcast(store: Store, user: User, value: unknown, userOperationHash: string, attempted = true) {
  const grant = await validateSponsoredBroadcast(store, user, value);
  if (!/^0x[\da-fA-F]{64}$/.test(userOperationHash)) throw new ApiError("SPONSORSHIP_HASH_INVALID", "The operation hash is invalid.", 502);
  return store.update<Grant>(user.id, "gas-sponsorship", grant.id, { status: attempted ? "submitted" : grant.status, userOperationHash });
}

export function settleSponsoredReceipt(store: Store, user: User, value: unknown) {
  const receipt = z.object({ userOpHash: bytes, sender: address, actualGasCost: quantity }).passthrough().safeParse(JSON.parse(JSON.stringify(value ?? null, (_, item) => typeof item === "bigint" ? `0x${item.toString(16)}` : item)));
  if (!receipt.success) return;
  const grant = store.list<Grant>(user.id, "gas-sponsorship", 500).find(row => row.userOperationHash?.toLowerCase() === receipt.data.userOpHash.toLowerCase());
  if (!grant || grant.status === "settled" || getAddress(grant.operation.sender) !== getAddress(receipt.data.sender) || BigInt(receipt.data.actualGasCost) > BigInt(grant.reserveWei)) return;
  store.update<Grant>(user.id, "gas-sponsorship", grant.id, { status: "settled", actualGasCostWei: BigInt(receipt.data.actualGasCost).toString() });
}

export function listGasSponsorship(store: Store, user: User) {
  return store.list<Grant>(user.id, "gas-sponsorship", 100).map(({ id, status, reserveWei, actualGasCostWei, userOperationHash, createdAt, expiresAt }) => ({ id, status, reserveWei, actualGasCostWei, userOperationHash, createdAt, expiresAt, currency: "eth", chainId: 11155111 }));
}

export async function reconcileGasSponsorship(store: Store, user: User, id: string) {
  const grant = store.get<Grant>(user.id, "gas-sponsorship", id);
  if (!grant?.userOperationHash) throw new ApiError("SPONSORSHIP_RECEIPT_PENDING", "No signed operation hash is available for receipt reconciliation. Its issued approval remains reserved.", 409);
  try {
    const response = await fetch(process.env.ZERODEV_RPC_URL!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: [grant.userOperationHash] }), signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!response.ok) throw new Error();
    const data = await response.json() as { result?: unknown };
    settleSponsoredReceipt(store, user, data.result);
  } catch { throw new ApiError("SPONSORSHIP_RECEIPT_PENDING", "A trusted operation receipt is not available. Its gas allowance remains reserved; do not resubmit.", 409); }
  return listGasSponsorship(store, user).find(item => item.id === id);
}
