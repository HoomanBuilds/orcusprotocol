import { getAddress, isAddressEqual, type Hex } from "viem";
import type { PreparedAction, TradingAccount } from "@orcus/core";
import { inspectPreparedOstiumAction, OSTIUM_TESTNET } from "@orcus/wallets/ostium";
import { EngineError } from "../../errors";
import type { SubmissionResult } from "../../types";
import { boundedOstiumRead, ostiumSdk, verifiedOstiumRpc } from "./client";
import { assertOstiumAccount, orderKey } from "./data";

const same = (a: string, b: string) => isAddressEqual(getAddress(a), getAddress(b));

export async function reconcileOstiumAction(action: { transactionHash?: string; txHash?: string; orderId?: string; prepared?: PreparedAction }, account: TradingAccount): Promise<SubmissionResult> {
  try {
  assertOstiumAccount(account);
  const hash = action.transactionHash ?? action.txHash;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { status: "submitted-unknown" };
  if (!action.prepared) throw new EngineError("SETTLEMENT_CONTEXT_MISSING", "The reviewed native Ostium action is required for reconciliation.");
  const checked = inspectPreparedOstiumAction({ ...action.prepared, expiresAt: Date.now() + 60_000 }, action.prepared.request.mode === "agent" ? "agent" : "owner");
  const rpc = await verifiedOstiumRpc(), receipt = await rpc.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
  if (!receipt) return { status: "pending", txHash: hash, evidence: { receipt: "unavailable" } };
  if (!checked.ostium.minimumBlock || !/^\d+$/.test(checked.ostium.minimumBlock) || receipt.blockNumber <= BigInt(checked.ostium.minimumBlock)) throw new EngineError("TRANSACTION_PREDATES_REVIEW", "This native transaction is not newer than the reviewed action's observed block.");
  if (receipt.status !== "success") return { status: "rejected", txHash: hash, evidence: { receipt: "reverted", blockNumber: receipt.blockNumber.toString() } };
  const transaction = await rpc.getTransaction({ hash: hash as Hex }), expected = checked.transactions!.at(-1)!;
  const sender = checked.request.mode === "agent" ? checked.ostium.delegate! : account.ownerAddress;
  if (!same(transaction.from, sender) || !transaction.to || !same(transaction.to, OSTIUM_TESTNET.trading) || transaction.value !== 0n || transaction.input.toLowerCase() !== expected.data.toLowerCase()) throw new EngineError("TRANSACTION_ACCOUNT_MISMATCH", "The transaction does not match this account's reviewed native action.");
  const evidence = { transactionHash: hash, blockNumber: receipt.blockNumber.toString(), trader: account.address, functionName: checked.ostium.functionName };
  const type = String(checked.request.type), client = await ostiumSdk(account.address), user = getAddress(account.address);
  if (["cancel", "edit-order", "stop-loss", "take-profit", "add-collateral"].includes(type)) return { status: type === "cancel" ? "cancelled" : "confirmed", txHash: hash, evidence: { ...evidence, effect: "native-control-confirmed", tradeFillClaimed: false } };
  if (type === "limit" || type === "stop") {
    const history = await boundedOstiumRead(() => client.getLimitOrderHistory({ user, limit: 200 }));
    const placement = history.find(event => event.event === "Placed" && event.hash.toLowerCase() === hash.toLowerCase() && event.pairId === String(checked.ostium.pairId) && same(event.trader, user));
    if (!placement) return { status: "pending", txHash: hash, evidence: { ...evidence, effect: "limit-accepted", lifecycle: "awaiting-indexer", tradeFillClaimed: false } };
    const lifecycle = history.filter(event => event.limitId === placement.limitId && event.pairId === placement.pairId && same(event.trader, user) && BigInt(event.block) > BigInt(placement.block)).sort((a, b) => Number(BigInt(a.block) - BigInt(b.block)));
    const nextPlacement = lifecycle.find(event => event.event === "Placed");
    const terminal = lifecycle.find(event => (event.event === "Canceled" || event.event === "Executed") && (!nextPlacement || BigInt(event.block) < BigInt(nextPlacement.block)));
    if (!terminal && nextPlacement) return { status: "submitted-unknown", txHash: hash, evidence: { ...evidence, effect: "limit-slot-reused", lifecycle: "original-terminal-event-not-proven", tradeFillClaimed: false } };
    if (!terminal) return { status: "pending", txHash: hash, orderId: orderKey(placement.pairId, placement.idx), evidence: { ...evidence, effect: "resting-order", limitId: placement.limitId, tradeFillClaimed: false } };
    if (terminal.event === "Canceled") return { status: "cancelled", txHash: hash, orderId: orderKey(placement.pairId, placement.idx), evidence: { ...evidence, effect: "limit-cancelled", tradeFillClaimed: false } };
    if (!terminal.oid) return { status: "pending", txHash: hash, evidence: { ...evidence, lifecycle: "triggered-awaiting-fill" } };
    const fills = await boundedOstiumRead(() => client.getOrders({ user, orderIds: [terminal.oid!], limit: 2 }));
    const fill = fills.find(order => same(order.trader, user) && order.oid === terminal.oid && order.limitId === placement.limitId && order.action === "Open" && order.pairId === String(checked.ostium.pairId) && !order.isPending && !order.isCancelled && /^0x[0-9a-fA-F]{64}$/.test(order.hash));
    return fill ? { status: "confirmed", txHash: hash, orderId: fill.oid, evidence: { ...evidence, executionHash: fill.hash, fill } } : { status: "pending", txHash: hash, orderId: terminal.oid, evidence: { ...evidence, lifecycle: "triggered-awaiting-fill" } };
  }
  const orders = await boundedOstiumRead(() => client.getOrders({ user, initiatedTxHashes: [hash as Hex], limit: 5 }));
  const expectedAction = type === "market" ? "Open" : type === "remove-collateral" ? "RemoveCollateral" : "Close";
  const matching = orders.filter(order => same(order.trader, user) && order.initiatedTx.toLowerCase() === hash.toLowerCase() && order.pairId === String(checked.ostium.pairId) && order.action === expectedAction && (!checked.ostium.positionId || `ostium-position:${order.pairId}:${order.pid}` === checked.ostium.positionId));
  if (matching.length !== 1) return { status: "pending", txHash: hash, evidence: { ...evidence, settlement: "awaiting-oracle-or-indexer" } };
  const order = matching[0];
  if (order.isPending) return { status: "pending", txHash: hash, orderId: order.oid, evidence: { ...evidence, settlement: "oracle-pending" } };
  if (order.isCancelled) return { status: "cancelled", txHash: hash, orderId: order.oid, evidence: { ...evidence, reason: order.cancelReason, tradeFillClaimed: false } };
  if (!/^0x[0-9a-fA-F]{64}$/.test(order.hash)) return { status: "pending", txHash: hash, orderId: order.oid, evidence: { ...evidence, settlement: "execution-evidence-pending" } };
  return { status: "confirmed", txHash: hash, orderId: order.oid, evidence: { ...evidence, executionHash: order.hash, fill: order } };
  } catch (error) { throw error instanceof EngineError ? error : new EngineError("OSTIUM_SETTLEMENT_UNAVAILABLE", "The recorded native action could not be reconciled safely. Do not repeat it.", 503); }
}
