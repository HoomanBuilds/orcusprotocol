import type { Hex } from "viem";
import { WalletActionError } from "./preflight";

export interface OperationReceipt {
  success: boolean;
  receipt: { transactionHash: Hex };
}

export async function broadcastPreparedOperation(input: {
  candidateHash: Hex;
  send: () => Promise<Hex>;
  wait: (hash: Hex) => Promise<OperationReceipt>;
  onSubmitted?: (evidence: { userOperationHash: string }) => Promise<void> | void;
}) {
  let hash: Hex;
  try { hash = await input.send(); }
  catch {
    try { await input.onSubmitted?.({ userOperationHash: input.candidateHash }); } catch {}
    throw new WalletActionError("SUBMISSION_UNKNOWN", "The bundler response was not confirmed. Check this user operation before retrying.", "submitted-unknown", { userOperationHash: input.candidateHash });
  }
  try { await input.onSubmitted?.({ userOperationHash: hash }); }
  catch { throw new WalletActionError("SUBMISSION_RECORDING_FAILED", "The user operation was sent but its activity record could not be saved. Do not submit it again.", "submitted-unknown", { userOperationHash: hash }); }
  let receipt: OperationReceipt;
  try { receipt = await input.wait(hash); }
  catch { throw new WalletActionError("RECEIPT_UNKNOWN", "The user operation was sent and is awaiting a confirmed receipt. Check activity before retrying.", "submitted-unknown", { userOperationHash: hash }); }
  return { transactionHash: receipt.receipt.transactionHash, userOperationHash: hash, status: receipt.success ? "confirmed" as const : "rejected" as const };
}
