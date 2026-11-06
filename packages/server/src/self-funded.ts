import { encodeCallDataEpV07, KernelV3_1AccountAbi } from "@zerodev/sdk";
import { createOwnerKernel, entryPoint, resolveKernelBundlerUrl } from "@orcus/wallets/kernel";
import { assertSelfFundedOperation, checkAccountGas, defaultOperationGasCapWei } from "@orcus/wallets/self-funded-gas";
import { inspectPreparedSwap } from "@orcus/wallets/preflight";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";
import { getUserOperationHash, type UserOperation } from "viem/account-abstraction";
import type { User } from "@orcus/core";
import { z } from "zod";
import { ApiError } from "./errors";
import type { Store } from "./store";
import type { StoredAccount, StoredAction, StoredRecord } from "./types";

const address = z.string().regex(/^0x[\da-fA-F]{40}$/), bytes = z.string().max(200_000).regex(/^0x(?:[\da-fA-F]{2})*$/), quantity = z.string().max(34).regex(/^0x[\da-fA-F]+$/);
const operationSchema = z.object({ sender: address, nonce: z.string().max(66).regex(/^0x[\da-fA-F]+$/), callData: bytes, factory: address.optional(), factoryData: bytes.optional(), callGasLimit: quantity, verificationGasLimit: quantity, preVerificationGas: quantity, maxFeePerGas: quantity, maxPriorityFeePerGas: quantity, signature: bytes.min(4) }).strict();
export const operationScopeSchema = z.object({ actionId: z.string().min(1).max(100).optional(), accountAddress: address.optional(), purpose: z.literal("permission-management").optional() }).strict();
type OperationRecord = StoredRecord & { sender: string; nonce: string; userOperationHash: string; status: "pending" | "settled"; maximumGasWei: string; actualGasCostWei?: string; transactionHash?: string; actionId?: string };

export function selfFundedSummary() {
  let configured = false;
  try { configured = Boolean(resolveKernelBundlerUrl({ BUNDLER_RPC_URL: process.env.BUNDLER_RPC_URL })); } catch {}
  return { configured, mode: "self-funded" as const, payer: "smart-account" as const, maxOperationGasWei: defaultOperationGasCapWei, chainId: 11155111 };
}

export function assertNoPaymaster(value: unknown) {
  if (!value || typeof value !== "object" || ["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterAndData"].some(key => (value as Record<string, unknown>)[key] !== undefined)) throw new ApiError("SPONSORSHIP_DISABLED", "Gas sponsorship is disabled. Prepare a self-funded smart-account operation.", 403);
}

export async function recordSelfFundedBroadcast(store: Store, user: User, scope: z.infer<typeof operationScopeSchema>, value: unknown) {
  assertNoPaymaster(value);
  const operation = operationSchema.parse(value);
  const maximumGasWei = assertSelfFundedOperation(operation);
  const action = scope.actionId ? store.get<StoredAction>(user.id, "action", scope.actionId) : undefined;
  const account = action ? store.get<StoredAccount>(user.id, "account", action.accountId!) : store.list<StoredAccount>(user.id, "account").find(item => item.address.toLowerCase() === scope.accountAddress?.toLowerCase());
  if (!account || account.venue !== "uniswap" || account.chainId !== 11155111 || !account.smartAccountAddress || getAddress(account.ownerAddress) !== getAddress(user.address) || getAddress(account.address) !== getAddress(operation.sender) || account.status === "unsupported") throw new ApiError("USER_OPERATION_ACCOUNT_MISMATCH", "Use this owner's registered Sepolia trading account.", 403);
  let callValue = 0n;
  if (scope.actionId) {
    if (!action || !["prepared", "awaiting-approval", "submitting"].includes(action.status) || action.expiresAt <= Date.now() || action.controlRevision !== account.controlRevision) throw new ApiError("ACTION_STALE", "Prepare a fresh action before submitting.", 409);
    inspectPreparedSwap(action.prepared);
    const calls = action.prepared.transactions!.map(tx => ({ to: getAddress(tx.to), data: tx.data as Hex, value: BigInt(tx.value) }));
    if ((await encodeCallDataEpV07(calls)).toLowerCase() !== operation.callData.toLowerCase()) throw new ApiError("USER_OPERATION_CALL_MISMATCH", "The operation must match the exact reviewed swap calls.", 403);
    callValue = calls.reduce((sum, call) => sum + call.value, 0n);
  } else {
    if (scope.purpose !== "permission-management") throw new ApiError("USER_OPERATION_SCOPE_REQUIRED", "A reviewed trade or explicit permission recovery scope is required.", 403);
    const decoded = decodeFunctionData({ abi: KernelV3_1AccountAbi, data: operation.callData as Hex });
    if (decoded.functionName === "invalidateNonce") {
      if (decoded.args[0] <= 0 || decoded.args[0] > 0xffffffff) throw new ApiError("USER_OPERATION_CALL_MISMATCH", "Invalid permission nonce floor.", 403);
    } else if (decoded.functionName === "uninstallValidation") {
      if (!decoded.args[0].startsWith("0x02") || decoded.args[2] !== "0x") throw new ApiError("USER_OPERATION_CALL_MISMATCH", "Only permission-validator removal is supported here.", 403);
    } else throw new ApiError("USER_OPERATION_CALL_MISMATCH", "Unsupported account management operation.", 403);
    if (encodeFunctionData({ abi: KernelV3_1AccountAbi, functionName: decoded.functionName, args: decoded.args as never }).toLowerCase() !== operation.callData.toLowerCase()) throw new ApiError("USER_OPERATION_CALL_MISMATCH", "Noncanonical permission-management data.", 403);
  }
  const owner = await createOwnerKernel({ rpcUrl: process.env.SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com", bundlerUrl: resolveKernelBundlerUrl({ BUNDLER_RPC_URL: process.env.BUNDLER_RPC_URL }) }, getAddress(user.address));
  if (getAddress(owner.account.address) !== getAddress(account.address)) throw new ApiError("USER_OPERATION_OWNER_MISMATCH", "This trading account is not derived from the signed-in owner.", 403);
  const factory = await owner.account.getFactoryArgs();
  if ((operation.factory ?? "").toLowerCase() !== (factory.factory ?? "").toLowerCase() || (operation.factoryData ?? "").toLowerCase() !== (factory.factoryData ?? "").toLowerCase()) throw new ApiError("USER_OPERATION_FACTORY_MISMATCH", "Deployment data does not match the owner's Kernel account.", 403);
  await checkAccountGas(owner.publicClient, getAddress(operation.sender), operation, callValue);
  const numeric = Object.fromEntries(["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"].map(key => [key, BigInt(operation[key as keyof typeof operation]!)]));
  const userOperationHash = getUserOperationHash({ userOperation: { ...operation, ...numeric } as unknown as UserOperation<"0.7">, entryPointAddress: entryPoint.address, entryPointVersion: "0.7", chainId: 11155111 });
  return store.db.transaction(() => {
    const previous = store.list<OperationRecord>(user.id, "kernel-operation", 500).find(row => row.sender.toLowerCase() === operation.sender.toLowerCase() && BigInt(row.nonce) === BigInt(operation.nonce));
    if (previous) throw new ApiError("USER_OPERATION_ALREADY_RECORDED", "This account nonce already has an operation. Reconcile its hash instead of resubmitting.", 409);
    const now = Date.now();
    if (action) store.update<StoredAction>(user.id, "action", action.id, { status: "pending", userOperationHash });
    return store.put("kernel-operation", { id: userOperationHash, userId: user.id, createdAt: now, updatedAt: now, sender: operation.sender, nonce: operation.nonce, userOperationHash, maximumGasWei: maximumGasWei.toString(), status: "pending", actionId: scope.actionId } satisfies OperationRecord);
  }).immediate();
}

export function settleSelfFundedReceipt(store: Store, user: User, value: unknown) {
  const result = z.object({ userOpHash: bytes, sender: address, actualGasCost: quantity, receipt: z.object({ transactionHash: bytes }).passthrough() }).passthrough().safeParse(value);
  if (!result.success) return;
  const record = store.get<OperationRecord>(user.id, "kernel-operation", result.data.userOpHash);
  if (!record || getAddress(record.sender) !== getAddress(result.data.sender)) return;
  store.update<OperationRecord>(user.id, "kernel-operation", record.id, { status: "settled", actualGasCostWei: BigInt(result.data.actualGasCost).toString(), transactionHash: result.data.receipt.transactionHash });
}
