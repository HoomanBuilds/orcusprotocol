import type { EvmTransaction, PreparedAction } from "@orcus/core";
import { getAddress, isAddressEqual, parseAbi, stringToHex, type Hex, type PublicClient } from "viem";
import { inspectPreparedOstiumAction, OSTIUM_TESTNET, ostiumTradingAbi } from "./ostium";
import { isOwnerRejection, WalletActionError } from "./preflight";

export async function assertOstiumOwnerDeployment(client: Pick<PublicClient, "getChainId" | "getStorageAt" | "readContract">) {
  if (await client.getChainId() !== OSTIUM_TESTNET.chainId) throw new WalletActionError("WRONG_NETWORK", "Switch to Arbitrum Sepolia before signing this native action.");
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const [trading, storage, callbacks, registry] = await Promise.all([
    client.getStorageAt({ address: OSTIUM_TESTNET.trading, slot }),
    client.getStorageAt({ address: OSTIUM_TESTNET.storage, slot }),
    client.getStorageAt({ address: OSTIUM_TESTNET.callbacks, slot }),
    client.readContract({ address: OSTIUM_TESTNET.trading, abi: ostiumTradingAbi, functionName: "registry" }),
  ]);
  const matches = (value: string | undefined, expected: string) => value !== undefined && isAddressEqual(getAddress(`0x${value.slice(-40)}`), getAddress(expected));
  if (!matches(trading, OSTIUM_TESTNET.implementation) || !matches(storage, OSTIUM_TESTNET.storageImplementation) || !matches(callbacks, OSTIUM_TESTNET.callbacksImplementation) || !isAddressEqual(registry, OSTIUM_TESTNET.registry)) throw new WalletActionError("OSTIUM_IMPLEMENTATION_UNREVIEWED", "Ostium's collateral or payout implementation changed. Nothing was signed; the upgrade needs review.");
  const abi = parseAbi(["function getContractAddress(bytes32) view returns (address)"]);
  const [storageAddress, callbacksAddress] = await Promise.all([client.readContract({ address: registry, abi, functionName: "getContractAddress", args: [stringToHex("tradingStorage", { size: 32 })] }), client.readContract({ address: registry, abi, functionName: "getContractAddress", args: [stringToHex("callbacks", { size: 32 })] })]);
  if (!isAddressEqual(storageAddress, OSTIUM_TESTNET.storage) || !isAddressEqual(callbacksAddress, OSTIUM_TESTNET.callbacks)) throw new WalletActionError("OSTIUM_DEPLOYMENT_CHANGED", "Ostium's collateral or payout deployment changed. Nothing was signed; review is required.");
}

export async function executeOstiumOwnerAction(prepared: PreparedAction, input: {
  assertReady: () => Promise<void>;
  send: (transaction: EvmTransaction) => Promise<Hex>;
  wait: (hash: Hex) => Promise<{ status: "success" | "reverted" }>;
  record: (evidence: { transactionHash?: string; approvalIndex?: number; result?: Record<string, unknown> }) => Promise<void>;
}) {
  const checked = inspectPreparedOstiumAction(prepared), approvals: Array<{ transactionHash: string; approvalIndex: number }> = [];
  for (const [index, transaction] of checked.transactions!.entries()) {
    const approval = index < checked.transactions!.length - 1;
    inspectPreparedOstiumAction(prepared);
    await input.assertReady();
    await input.record({ result: approval ? { venue: "ostium", approvalStarted: true, approvalIndex: index } : { venue: "ostium", tradeStarted: true } });
    let hash: Hex;
    try { hash = await input.send(transaction); }
    catch (error) {
      if (isOwnerRejection(error)) {
        try { await input.record({ result: { venue: "ostium", ownerRejected: true, phase: approval ? "approval" : "trade", approvalIndex: approval ? index : undefined } }); } catch {}
        throw new WalletActionError("OWNER_REJECTED", approvals.length ? "You declined the next signature. Earlier approvals remain onchain; no trade was submitted." : "You declined the wallet signature. Nothing was submitted.", "not-submitted", { approvals });
      }
      try { await input.record({ result: { venue: "ostium", submissionUnknown: true, phase: approval ? "approval" : "trade", approvalIndex: approval ? index : undefined } }); } catch {}
      throw new WalletActionError("SUBMISSION_UNKNOWN", "The wallet response is unknown. Check native transactions and activity before retrying.", "submitted-unknown", { approvals, approvalIndex: approval ? index : undefined });
    }
    const evidence = { transactionHash: hash, ...(approval ? { approvalIndex: index } : {}) };
    try { await input.record(evidence); }
    catch { throw new WalletActionError("SUBMISSION_RECORDING_FAILED", "The transaction was sent but its activity record could not be saved. Do not submit it again.", "submitted-unknown", { ...evidence, approvals }); }
    if (!approval) return { transactionHash: hash, response: { settlement: "native-confirmation-pending", approvals } };
    approvals.push({ transactionHash: hash, approvalIndex: index });
    let receipt;
    try { receipt = await input.wait(hash); }
    catch { throw new WalletActionError("RECEIPT_UNKNOWN", "The allowance transaction was sent. Wait for its receipt before reviewing a new trade.", "submitted-unknown", { ...evidence, approvals }); }
    if (receipt.status !== "success") throw new WalletActionError("APPROVAL_REVERTED", "The allowance reverted. No trade was submitted.", "reverted", { ...evidence, approvals });
    try { await input.record(evidence); }
    catch { throw new WalletActionError("SUBMISSION_RECORDING_FAILED", "The allowance confirmed, but its proof could not be saved. No trade was submitted.", "submitted-unknown", { ...evidence, approvals }); }
  }
  throw new WalletActionError("OSTIUM_CALL_MISMATCH", "The native action is missing.");
}
