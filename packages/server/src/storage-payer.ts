import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { nativeAmount } from "@orcus/engine/budget";
import type { User } from "@orcus/core";
import { ApiError } from "./errors";
import type { Store } from "./store";

type Limits = { maxGas0G?: string; maxStorageFee0G?: string };
type PayerInput = { limits?: Limits; agent: () => { payerAddress: string; privateKey: string } };
export type StoragePayer = { userId: string; payerAddress: `0x${string}`; privateKey: `0x${string}`; scope: string; limits: Required<Limits>; costBearer: "operator" | "agent"; dailyCapWei?: string };
type NativeExpense = { userId: string; payerAddress: string; transactionHash: string; status: string; maxGasWei: string; maxStorageFeeWei: string; totalSpentWei?: string; observedAt: number };

function positive(value: string | undefined, fallback: string, name: string): { value: string; atoms: bigint } {
  const amount = value ?? fallback;
  try { return { value: amount, atoms: nativeAmount(amount) }; }
  catch { throw new ApiError("INVALID_STORAGE_PAYER_CONFIG", `${name} must be an exact positive 0G amount with at most eighteen decimals.`, 503); }
}

function account(key: string | undefined): { privateKey: `0x${string}`; payerAddress: `0x${string}` } {
  try {
    if (!key || !/^0x[\da-fA-F]{64}$/.test(key)) throw new Error();
    return { privateKey: key as `0x${string}`, payerAddress: privateKeyToAccount(key as `0x${string}`).address };
  } catch { throw new ApiError("STORAGE_PAYER_UNCONFIGURED", "The selected storage payer needs a valid server-only signing key.", 503); }
}

function privatePayer(payer: StoragePayer): StoragePayer { Object.defineProperty(payer, "privateKey", { value: payer.privateKey, enumerable: false }); return payer; }

export function selectStoragePayer(_store: Store, user: User, input: PayerInput, env: NodeJS.ProcessEnv = process.env): StoragePayer {
  const mode = env.ZEROG_STORAGE_PAYER ?? "agent";
  if (mode !== "agent" && mode !== "operator") throw new ApiError("INVALID_STORAGE_PAYER_CONFIG", "ZEROG_STORAGE_PAYER must be exactly agent or operator.", 503);
  if (mode === "agent") {
    const agent = input.agent(), signer = account(agent.privateKey);
    if (signer.payerAddress.toLowerCase() !== agent.payerAddress.toLowerCase()) throw new ApiError("STORAGE_PAYER_MISMATCH", "The operating signer does not match the selected storage account.", 409);
    return privatePayer({ ...signer, userId: user.id, scope: `operating:${user.id}`, limits: { maxGas0G: positive(input.limits?.maxGas0G, "0.003", "Storage gas cap").value, maxStorageFee0G: positive(input.limits?.maxStorageFee0G, "0.01", "Storage fee cap").value }, costBearer: "agent" });
  }
  const signer = account(env.ZEROG_STORAGE_SPONSOR_PRIVATE_KEY);
  const gas = positive(env.ZEROG_STORAGE_SPONSOR_MAX_GAS_0G, "0.003", "Operator gas ceiling"), fee = positive(env.ZEROG_STORAGE_SPONSOR_MAX_STORAGE_FEE_0G, "0.01", "Operator storage fee ceiling"), daily = positive(env.ZEROG_STORAGE_SPONSOR_DAILY_CAP_0G, "0.05", "Operator daily cap");
  const requestedGas = positive(input.limits?.maxGas0G, gas.value, "Storage gas cap"), requestedFee = positive(input.limits?.maxStorageFee0G, fee.value, "Storage fee cap");
  if (requestedGas.atoms > gas.atoms || requestedFee.atoms > fee.atoms) throw new ApiError("STORAGE_SPONSOR_LIMIT", "Requested backup caps exceed the operator's native gas or storage fee ceiling.", 409);
  return privatePayer({ ...signer, userId: user.id, scope: `storage-payer:${signer.payerAddress.toLowerCase()}`, limits: { maxGas0G: requestedGas.value, maxStorageFee0G: requestedFee.value }, costBearer: "operator", dailyCapWei: daily.atoms.toString() });
}

function native(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,79})$/.test(value)) throw new ApiError("STORAGE_PAYER_LEDGER_INVALID", "The native storage expense ledger must be reconciled before another sponsored backup.", 409);
  return BigInt(value);
}

function usage(store: Store, payer: StoragePayer, currentTransactionHash?: string, now = Date.now()) {
  const start = Math.floor(now / 86_400_000) * 86_400_000;
  let spent = 0n, reserved = 0n, currentReserved = false, blocked = false;
  const rows = store.db.prepare("SELECT user_id,body FROM records WHERE kind='native-expense' AND lower(json_extract(body,'$.payerAddress'))=? AND json_extract(body,'$.chainId')=16602 AND json_extract(body,'$.currency')='0g' AND json_extract(body,'$.unit')='neuron'").all(payer.payerAddress.toLowerCase()) as { user_id: string; body: string }[];
  const seen = new Set<string>();
  for (const row of rows) {
    const expense = JSON.parse(row.body) as NativeExpense;
    if (!/^0x[\da-fA-F]{64}$/.test(expense.transactionHash) || !Number.isSafeInteger(expense.observedAt) || expense.observedAt < 1 || expense.observedAt > now + 60_000) throw new ApiError("STORAGE_PAYER_LEDGER_INVALID", "The payer's native expense evidence is invalid or has an untrusted timestamp.", 409);
    const hash = expense.transactionHash.toLowerCase();
    const pending = ["reserved", "submitting", "submitted-unknown"].includes(expense.status);
    if (pending) {
      const own = row.user_id === payer.userId && currentTransactionHash?.toLowerCase() === hash;
      if (own && (native(expense.maxGasWei) !== nativeAmount(payer.limits.maxGas0G) || native(expense.maxStorageFeeWei) !== nativeAmount(payer.limits.maxStorageFee0G))) throw new ApiError("STORAGE_PAYER_LEDGER_INVALID", "The signed backup reservation does not match this payer's selected native limits.", 409);
      if (!own) blocked = true;
      if (!seen.has(hash)) reserved += native(expense.maxGasWei) + native(expense.maxStorageFeeWei);
      if (own) currentReserved = true;
    } else if (["confirmed", "reverted", "not-submitted"].includes(expense.status)) {
      if (!seen.has(hash) && expense.observedAt >= start) spent += native(expense.totalSpentWei);
    } else throw new ApiError("STORAGE_PAYER_LEDGER_INVALID", "Reconcile the payer's unknown native expense state before another backup.", 409);
    seen.add(hash);
  }
  return { spent, reserved, currentReserved, blocked, utcDay: new Date(start).toISOString().slice(0, 10) };
}

export function assertStoragePayerAllowance(store: Store, payer: StoragePayer, currentTransactionHash?: string) {
  const current = usage(store, payer, currentTransactionHash);
  if (current.blocked) throw new ApiError("STORAGE_PAYER_PENDING", "This storage payer has an unresolved transaction. Reconcile it before funding another backup.", 409);
  if (payer.costBearer === "operator") {
    const additional = current.currentReserved ? 0n : nativeAmount(payer.limits.maxGas0G) + nativeAmount(payer.limits.maxStorageFee0G);
    if (current.spent + current.reserved + additional > native(payer.dailyCapWei)) throw new ApiError("STORAGE_SPONSOR_DAILY_CAP", "The operator's UTC-day native storage cap cannot cover another backup and its maximum gas cost.", 402);
  }
}

export function publicStoragePayerMetadata(store: Store, payer: StoragePayer) {
  const current = usage(store, payer);
  return { costBearer: payer.costBearer, payerAddress: payer.payerAddress, userNeeds0G: payer.costBearer === "agent", currency: "0g", chainId: 16602, limits: { ...payer.limits }, utcDay: current.utcDay, ...(payer.dailyCapWei ? { dailyCap0G: formatEther(native(payer.dailyCapWei)), dailySpent0G: formatEther(current.spent), reserved0G: formatEther(current.reserved) } : {}), pending: current.blocked, message: payer.costBearer === "operator" ? "The operator pays native storage fees and gas within its shared daily cap. This does not prove paid service credits or a funded wallet balance." : "The isolated agent operating wallet pays native storage fees and gas. Trading principal is not used." };
}
