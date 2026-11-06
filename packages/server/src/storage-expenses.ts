import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors";
import type { Store } from "./store";

const atoms = z.string().regex(/^(?:0|[1-9]\d{0,79})$/);
const storageExpense = z.object({ kind: z.literal("storage"), currency: z.literal("0g"), unit: z.literal("neuron"), chainId: z.literal(16602), status: z.enum(["confirmed", "reverted", "submitted-unknown", "not-submitted"]), transactionHash: z.string().regex(/^0x[\da-fA-F]{64}$/), rootHash: z.string().regex(/^0x[\da-fA-F]{64}$/), payerAddress: z.string().regex(/^0x[\da-fA-F]{40}$/), to: z.string().regex(/^0x[\da-fA-F]{40}$/), calldataHash: z.string().regex(/^0x[\da-fA-F]{64}$/), storageValueWei: atoms, maxGasWei: atoms, maxStorageFeeWei: atoms, gasPaidWei: atoms.optional(), storageFeeWei: atoms.optional(), totalSpentWei: atoms.optional(), blockNumber: z.string().regex(/^\d+$/).optional(), observedAt: z.number().int().positive() });
type NativeStorageExpense = z.infer<typeof storageExpense> & { id: string; userId: string; createdAt: number; updatedAt: number };

export function recordStorageExpense(store: Store, userId: string, input: unknown) {
  const expense = storageExpense.parse(input);
  if (expense.status !== "submitted-unknown" && (expense.gasPaidWei === undefined || expense.storageFeeWei === undefined || expense.totalSpentWei === undefined || BigInt(expense.gasPaidWei) + BigInt(expense.storageFeeWei) !== BigInt(expense.totalSpentWei) || BigInt(expense.gasPaidWei) > BigInt(expense.maxGasWei) || BigInt(expense.storageFeeWei) > BigInt(expense.maxStorageFeeWei) || expense.status === "reverted" && expense.storageFeeWei !== "0")) throw new ApiError("STORAGE_EXPENSE_MISMATCH", "A confirmed native expense must have matching receipt costs within its gas and storage fee limits.", 409);
  if (expense.status === "submitted-unknown" && [expense.gasPaidWei, expense.storageFeeWei, expense.totalSpentWei].some(value => value !== undefined)) throw new ApiError("STORAGE_EXPENSE_MISMATCH", "Unknown storage submissions must not claim confirmed costs.", 409);
  if (expense.status === "not-submitted" && expense.totalSpentWei !== "0") throw new ApiError("STORAGE_EXPENSE_MISMATCH", "A transaction known not to be submitted cannot have an onchain expense.", 409);
  if (expense.status === "confirmed" && expense.storageFeeWei !== expense.storageValueWei) throw new ApiError("STORAGE_EXPENSE_MISMATCH", "The storage fee must match the value in the bound signed transaction.", 409);
  const id = `storage-expense:${createHash("sha256").update(`${userId}:${expense.transactionHash.toLowerCase()}`).digest("hex")}`;
  return store.db.transaction(() => {
    const previous = store.get<NativeStorageExpense>(userId, "native-expense", id);
    if (previous && ["rootHash", "payerAddress", "to", "calldataHash", "storageValueWei", "maxGasWei", "maxStorageFeeWei"].some(key => previous[key as keyof NativeStorageExpense]?.toString().toLowerCase() !== expense[key as keyof typeof expense]?.toString().toLowerCase())) throw new ApiError("STORAGE_EXPENSE_MISMATCH", "This transaction already belongs to another encrypted backup or signed expense bound.", 409);
    if (previous && previous.status !== "submitted-unknown") return previous;
    const now = Date.now();
    return store.put("native-expense", { ...expense, id, userId, createdAt: previous?.createdAt ?? now, updatedAt: now });
  })();
}

export function listStorageExpenses(store: Store, userId: string) { return store.list<NativeStorageExpense>(userId, "native-expense", 50); }
