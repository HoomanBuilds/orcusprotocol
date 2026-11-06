import { JsonRpcProvider, Wallet, getAddress, keccak256, type TransactionRequest } from "ethers";
import { nativeAmount } from "../budget/funding";
import { EngineError } from "../errors";
import { engineConfig } from "../config";
import { z } from "zod";

const hash = z.string().regex(/^0x[\da-fA-F]{64}$/), address = z.string().regex(/^0x[\da-fA-F]{40}$/), atoms = z.string().regex(/^(?:0|[1-9]\d{0,79})$/);
const expenseSchema = z.object({ kind: z.literal("storage"), currency: z.literal("0g"), unit: z.literal("neuron"), chainId: z.literal(16602), status: z.enum(["confirmed", "reverted", "submitted-unknown", "not-submitted"]), transactionHash: hash, rootHash: hash, payerAddress: address, to: address, calldataHash: hash, storageValueWei: atoms, maxGasWei: atoms, maxStorageFeeWei: atoms, gasPaidWei: atoms.optional(), storageFeeWei: atoms.optional(), totalSpentWei: atoms.optional(), blockNumber: z.string().regex(/^\d+$/).optional(), observedAt: z.number().int().positive() });
export type StorageExpense = z.infer<typeof expenseSchema>;
export type StorageUploadOptions = { maxGas0G?: string; maxStorageFee0G?: string; expectedFlowAddress?: string; assertAuthority?: () => void | Promise<void>; onSubmissionIntent?: (expense: StorageExpense) => void | Promise<void>; onExpense?: (expense: StorageExpense) => void | Promise<void> };

async function readStorageExpense(provider: JsonRpcProvider, expense: StorageExpense): Promise<StorageExpense> {
  const result: StorageExpense = { ...expense, status: "submitted-unknown", gasPaidWei: undefined, storageFeeWei: undefined, totalSpentWei: undefined, blockNumber: undefined, observedAt: Date.now() };
  try {
    const [receipt, tx] = await Promise.all([provider.getTransactionReceipt(expense.transactionHash), provider.getTransaction(expense.transactionHash)]);
    if (!receipt || !tx) return result;
    if (!tx.to || getAddress(tx.from) !== getAddress(expense.payerAddress) || getAddress(tx.to) !== getAddress(expense.to) || tx.chainId !== 16602n || tx.hash.toLowerCase() !== expense.transactionHash.toLowerCase() || receipt.hash.toLowerCase() !== expense.transactionHash.toLowerCase() || keccak256(tx.data).toLowerCase() !== expense.calldataHash.toLowerCase() || tx.value !== BigInt(expense.storageValueWei)) throw new EngineError("STORAGE_RECEIPT_MISMATCH", "Storage receipt identity did not match the signed operating-wallet upload.", 409);
    const gasPaid = receipt.gasUsed * receipt.gasPrice, fee = receipt.status === 1 ? tx.value : 0n;
    if (gasPaid > BigInt(expense.maxGasWei) || fee > BigInt(expense.maxStorageFeeWei)) throw new EngineError("STORAGE_RECEIPT_MISMATCH", "Storage receipt costs exceeded the authorized native limits.", 409);
    return { ...result, status: receipt.status === 1 ? "confirmed" : "reverted", gasPaidWei: gasPaid.toString(), storageFeeWei: fee.toString(), totalSpentWei: (gasPaid + fee).toString(), blockNumber: String(receipt.blockNumber) };
  } catch (error) { if (error instanceof EngineError) throw error; return result; }
}

export async function reconcileStorageExpense(value: unknown): Promise<StorageExpense> {
  const expense = expenseSchema.parse(value), provider = new JsonRpcProvider(engineConfig().storage.rpcUrl);
  if ((await provider.getNetwork()).chainId !== 16602n) throw new EngineError("WRONG_NETWORK", "Storage receipts must be reconciled on Galileo testnet.", 409);
  return readStorageExpense(provider, expense);
}

export function boundedStorageSigner(privateKey: string, provider: JsonRpcProvider, rootHash: string, options: StorageUploadOptions) {
  const maxGasWei = nativeAmount(options.maxGas0G ?? "0.003"), maxStorageFeeWei = nativeAmount(options.maxStorageFee0G ?? "0.01");
  let allowedFlow: string | undefined, submitSelector: string | undefined, candidateHash: string | undefined, attempted = false, submissionStarted = false, populated: TransactionRequest | undefined, confirmedExpense: StorageExpense | undefined;
  const base = (): StorageExpense => ({ kind: "storage", currency: "0g", unit: "neuron", chainId: 16602, status: "submitted-unknown", transactionHash: candidateHash!, rootHash, payerAddress: signer.address, to: String(populated!.to), calldataHash: keccak256(populated!.data as string), storageValueWei: BigInt(populated!.value ?? 0).toString(), maxGasWei: maxGasWei.toString(), maxStorageFeeWei: maxStorageFeeWei.toString(), observedAt: Date.now() });
  const authority = async () => { await options.assertAuthority?.(); };
  class CappedSigner extends Wallet {
    override async sendTransaction(request: TransactionRequest) {
      if (submissionStarted) throw new EngineError("STORAGE_RETRY_BLOCKED", "A storage upload may submit only one transaction. Reconcile its existing hash before retrying.", 409);
      submissionStarted = true;
      await authority();
      const tx = await this.populateTransaction(request), data = tx.data?.toString();
      if (tx.chainId !== 16602n || !allowedFlow || !tx.to || getAddress(String(tx.to)) !== allowedFlow || !submitSelector || !data?.startsWith(submitSelector)) throw new EngineError("STORAGE_TRANSACTION_MISMATCH", "The storage transaction must call the selected Galileo Flow submit function.", 409);
      const value = BigInt(tx.value ?? 0), gas = BigInt(tx.gasLimit ?? 0), price = BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? 0);
      if (value < 0n || value > maxStorageFeeWei || gas <= 0n || price <= 0n || gas * price > maxGasWei) throw new EngineError("STORAGE_EXPENSE_CAP", "The storage fee or maximum network gas exceeds this backup's native 0G cap.", 409);
      if (await provider.getBalance(this.address) < value + gas * price) throw new EngineError("OPERATING_BALANCE_LOW", "Fund the isolated operating wallet before backing up memory. Trading funds will not be used.", 402);
      await authority();
      const signed = await this.signTransaction(tx);
      candidateHash = keccak256(signed); populated = tx;
      await options.onSubmissionIntent?.(base());
      await authority();
      attempted = true;
      const response = await provider.broadcastTransaction(signed);
      if (response.hash.toLowerCase() !== candidateHash.toLowerCase()) throw new EngineError("STORAGE_HASH_MISMATCH", "The RPC returned an inconsistent upload transaction hash.", 502);
      return response;
    }
  }
  const signer = new CappedSigner(privateKey, provider);
  return {
    signer,
    allowFlow: (address: string, selector: string) => { if (allowedFlow || !/^0x[\da-fA-F]{8}$/.test(selector)) throw new EngineError("INVALID_STORAGE_FLOW", "A storage upload requires one fixed Flow submit selector."); allowedFlow = getAddress(address); submitSelector = selector; },
    attempted: () => attempted,
    candidateHash: () => candidateHash,
    expense: async (): Promise<StorageExpense | undefined> => {
      if (!candidateHash) return undefined;
      if (confirmedExpense) return confirmedExpense;
      const result: StorageExpense = attempted ? await readStorageExpense(provider, base()) : { ...base(), status: "not-submitted", gasPaidWei: "0", storageFeeWei: "0", totalSpentWei: "0" };
      await options.onExpense?.(result);
      if (result.status !== "submitted-unknown") confirmedExpense = result;
      return result;
    },
  };
}
