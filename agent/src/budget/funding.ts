import { createHash } from "node:crypto";
import { createPublicClient, decodeFunctionData, defineChain, encodeFunctionData, getAddress, http, isAddressEqual, keccak256, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { EngineError } from "../errors";

export const computePaymentVault = "0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939" as const;
export const computePaymentVaultAbi = [
  { inputs: [{ name: "user", type: "address" }], name: "depositFor", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "user", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;
const galileo = defineChain({ id: 16602, name: "0G Galileo Testnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: ["https://evmrpc-testnet.0g.ai"] } }, testnet: true });
const address = z.string().regex(/^0x[\da-fA-F]{40}$/);
const atoms = z.string().regex(/^[1-9]\d{0,79}$/);
const intentSchema = z.object({ id: z.string().min(1).max(100), userId: z.string().min(1).max(100), ownerAddress: address, payerAddress: address, computeAccountAddress: address, chainId: z.literal(16602), currency: z.literal("0g"), amountWei: atoms, maxGasWei: atoms, to: address, data: z.string().regex(/^0x[\da-fA-F]+$/), expiresAt: z.number().int().positive(), policyRevision: z.number().int().positive(), createdAt: z.number().int().positive() });
export type ComputeFundingIntent = z.infer<typeof intentSchema>;
export type ComputeFundingResult = { status: "confirmed" | "failed" | "submitted-unknown"; transactionHash: string; amountWei?: string; gasPaidWei?: string; beneficiary?: string; chainId: 16602; blockNumber?: string; creditStatus: "awaiting-router-sync" | "router-balance-observed" | "unconfirmed"; message?: string };

export function nativeAmount(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,18})?$/.test(value)) throw new EngineError("INVALID_FUNDING_AMOUNT", "Use an exact positive 0G amount with at most 18 decimals.");
  const parsed = parseEther(value);
  if (parsed <= 0n) throw new EngineError("INVALID_FUNDING_AMOUNT", "Funding and gas limits must be positive.");
  return parsed;
}

export function buildComputeFunding(input: { id: string; userId: string; ownerAddress: string; payerAddress: string; computeAccountAddress: string; topUp0G: string; maxGas0G: string; expiresAt: number; policyRevision: number }): ComputeFundingIntent {
  const account = getAddress(input.computeAccountAddress), payer = getAddress(input.payerAddress), owner = getAddress(input.ownerAddress);
  if (isAddressEqual(payer, owner)) throw new EngineError("OPERATING_WALLET_REQUIRED", "Compute replenishment must use the separate operating wallet, never the owner trading wallet.");
  const now = Date.now();
  if (input.expiresAt <= now || input.expiresAt > now + 300_000) throw new EngineError("INVALID_FUNDING_EXPIRY", "A prepared compute deposit must expire within five minutes.");
  return intentSchema.parse({ id: input.id, userId: input.userId, ownerAddress: owner, payerAddress: payer, computeAccountAddress: account, chainId: 16602, currency: "0g", amountWei: nativeAmount(input.topUp0G).toString(), maxGasWei: nativeAmount(input.maxGas0G).toString(), to: computePaymentVault, data: encodeFunctionData({ abi: computePaymentVaultAbi, functionName: "depositFor", args: [account] }), expiresAt: input.expiresAt, policyRevision: input.policyRevision, createdAt: now });
}

export function validateComputeFunding(value: unknown): ComputeFundingIntent {
  const intent = intentSchema.parse(value);
  if (!isAddressEqual(getAddress(intent.to), computePaymentVault) || isAddressEqual(getAddress(intent.payerAddress), getAddress(intent.ownerAddress))) throw new EngineError("FUNDING_DESTINATION_MISMATCH", "Compute deposits must use the fixed Galileo vault and separate operating payer.");
  const decoded = decodeFunctionData({ abi: computePaymentVaultAbi, data: intent.data as Hex });
  const expected = encodeFunctionData({ abi: computePaymentVaultAbi, functionName: "depositFor", args: [getAddress(intent.computeAccountAddress)] });
  if (decoded.functionName !== "depositFor" || !isAddressEqual(decoded.args[0], getAddress(intent.computeAccountAddress)) || intent.data.toLowerCase() !== expected.toLowerCase()) throw new EngineError("FUNDING_ACCOUNT_MISMATCH", "The deposit calldata does not match the approved compute account.");
  return intent;
}

function client() { return createPublicClient({ chain: galileo, transport: http(process.env.ZEROG_STORAGE_RPC_URL || galileo.rpcUrls.default.http[0], { retryCount: 0, timeout: 15_000 }) }); }
async function verifiedClient() {
  const rpc = client();
  const code = await rpc.getCode({ address: computePaymentVault });
  if (await rpc.getChainId() !== galileo.id || !code || code === "0x") throw new EngineError("FUNDING_NETWORK_MISMATCH", "The funding RPC must be Galileo with the documented payment vault deployed.");
  return rpc;
}

export async function readComputeVaultBalance(computeAccountAddress: string) {
  const rpc = await verifiedClient();
  const balance = await rpc.readContract({ address: computePaymentVault, abi: computePaymentVaultAbi, functionName: "balanceOf", args: [getAddress(computeAccountAddress)] });
  return { currency: "0g" as const, chainId: 16602 as const, accountAddress: getAddress(computeAccountAddress), balanceNeurons: balance.toString(), source: "payment-vault" as const, observedAt: Date.now() };
}

export async function submitComputeFunding(value: unknown, privateKey: string, options: { assertAuthority: () => void | Promise<void>; onSubmissionIntent: (transactionHash: string) => void | Promise<void> }): Promise<ComputeFundingResult> {
  let attempted = false, hash: Hex | undefined;
  try {
    const intent = validateComputeFunding(value), payer = privateKeyToAccount(privateKey as Hex);
    if (!isAddressEqual(payer.address, getAddress(intent.payerAddress))) throw new EngineError("FUNDING_PAYER_MISMATCH", "The operating signer does not match this approved deposit.");
    const ready = async () => { await options.assertAuthority(); if (intent.expiresAt <= Date.now()) throw new EngineError("FUNDING_EXPIRED", "This compute deposit expired before submission.", 409); };
    await ready();
    const rpc = await verifiedClient(), amount = BigInt(intent.amountWei);
    await rpc.simulateContract({ account: payer.address, address: computePaymentVault, abi: computePaymentVaultAbi, functionName: "depositFor", args: [getAddress(intent.computeAccountAddress)], value: amount });
    const [estimate, fees, nonce, balance] = await Promise.all([rpc.estimateGas({ account: payer.address, to: computePaymentVault, data: intent.data as Hex, value: amount }), rpc.estimateFeesPerGas(), rpc.getTransactionCount({ address: payer.address, blockTag: "pending" }), rpc.getBalance({ address: payer.address })]);
    const gas = estimate * 120n / 100n;
    if (gas * fees.maxFeePerGas > BigInt(intent.maxGasWei)) throw new EngineError("FUNDING_GAS_CAP", "The estimated network fee exceeds the owner-approved operating gas cap.", 409);
    if (balance < amount + gas * fees.maxFeePerGas) throw new EngineError("OPERATING_BALANCE_LOW", "Fund the operating wallet before replenishing compute. Trading funds will not be used.", 402);
    await ready();
    const signed = await payer.signTransaction({ chainId: galileo.id, to: computePaymentVault, data: intent.data as Hex, value: amount, gas, nonce, ...fees, type: "eip1559" });
    hash = keccak256(signed);
    await options.onSubmissionIntent(hash);
    await ready();
    attempted = true;
    const returned = await rpc.sendRawTransaction({ serializedTransaction: signed });
    if (returned.toLowerCase() !== hash.toLowerCase()) return { status: "submitted-unknown", transactionHash: hash, chainId: 16602, creditStatus: "unconfirmed", message: "The RPC returned inconsistent deposit identity. Reconcile the signed hash before retrying." };
    await rpc.waitForTransactionReceipt({ hash, timeout: 90_000 });
    return reconcileComputeFunding(intent, hash);
  } catch (error) {
    if (attempted && hash) return { status: "submitted-unknown", transactionHash: hash, chainId: 16602, creditStatus: "unconfirmed", message: "Compute deposit submission is uncertain. It will not be repeated automatically." };
    throw Object.assign(error instanceof EngineError ? error : new EngineError("FUNDING_PREFLIGHT_FAILED", "The compute deposit could not be prepared. Nothing was submitted.", 409), { phase: "not-submitted" as const, transactionHash: hash, evidence: hash ? { transactionHash: hash } : undefined });
  }
}

export async function reconcileComputeFunding(value: unknown, transactionHash: string): Promise<ComputeFundingResult> {
  const intent = validateComputeFunding(value);
  if (!/^0x[\da-fA-F]{64}$/.test(transactionHash)) throw new EngineError("INVALID_FUNDING_HASH", "A valid deposit transaction hash is required.");
  const rpc = await verifiedClient(), hash = transactionHash as Hex;
  try {
    const [tx, receipt] = await Promise.all([rpc.getTransaction({ hash }), rpc.getTransactionReceipt({ hash })]);
    if (!tx.to || !isAddressEqual(tx.to, computePaymentVault) || !isAddressEqual(tx.from, getAddress(intent.payerAddress)) || tx.input.toLowerCase() !== intent.data.toLowerCase() || tx.value !== BigInt(intent.amountWei) || tx.chainId !== galileo.id) throw new EngineError("FUNDING_EVIDENCE_MISMATCH", "The transaction does not match this operating-wallet compute deposit.", 409);
    const gasPaidWei = receipt.gasUsed * receipt.effectiveGasPrice;
    if (gasPaidWei > BigInt(intent.maxGasWei)) throw new EngineError("FUNDING_GAS_EVIDENCE_MISMATCH", "The deposit fee exceeds the authorized bound.", 409);
    return { status: receipt.status === "success" ? "confirmed" : "failed", transactionHash, chainId: 16602, amountWei: receipt.status === "success" ? intent.amountWei : "0", gasPaidWei: gasPaidWei.toString(), beneficiary: intent.computeAccountAddress, blockNumber: receipt.blockNumber.toString(), creditStatus: receipt.status === "success" ? "awaiting-router-sync" : "unconfirmed" };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return { status: "submitted-unknown", transactionHash, chainId: 16602, creditStatus: "unconfirmed", message: "The payment receipt is not available yet; no compute credit is claimed." };
  }
}

export function computeFundingFingerprint(intent: ComputeFundingIntent) { return createHash("sha256").update(JSON.stringify(validateComputeFunding(intent))).digest("hex"); }
