import type { EvmTransaction, PreparedAction, TradeRequest, TradingAccount } from "@orcus/core";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, isAddressEqual, parseAbi, zeroAddress, type Hex } from "viem";
import { exactTokenAmount, WalletActionError } from "./preflight";
import { OSTIUM_TESTNET } from "./ostium-deployment";
export { OSTIUM_TESTNET } from "./ostium-deployment";

export const ostiumTradingAbi = parseAbi([
  "function openTrade((uint256 collateral,uint192 openPrice,uint192 tp,uint192 sl,address trader,uint32 leverage,uint16 pairIndex,uint8 index,bool buy,bool isDayTrade) t,(address builder,uint32 builderFee) bf,uint8 orderType,uint256 slippageP)",
  "function closeTradeMarket(uint16 pairIndex,uint8 index,uint16 closePercentage,uint192 marketPrice,uint32 slippageP)",
  "function updateOpenLimitOrder(uint16 pairIndex,uint8 index,uint192 price,uint192 tp,uint192 sl)",
  "function cancelOpenLimitOrder(uint16 pairIndex,uint8 index)",
  "function updateTp(uint16 pairIndex,uint8 index,uint192 price)",
  "function updateSl(uint16 pairIndex,uint8 index,uint192 price)",
  "function topUpCollateral(uint16 pairIndex,uint8 index,uint256 amount)",
  "function removeCollateral(uint16 pairIndex,uint8 index,uint256 amount)",
  "function openTradeMarketTimeout(uint256 orderId)",
  "function closeTradeMarketTimeout(uint256 orderId,bool retry)",
  "function delegatedAction(address trader,bytes call_data) returns (bytes)",
  "function setDelegate(address delegate)",
  "function removeDelegate()",
  "function delegations(address trader) view returns (address)",
  "function registry() view returns (address)",
  "function isPaused() view returns (bool)",
  "function isDone() view returns (bool)",
]);

export interface OstiumExecutionContext {
  pairId: number;
  symbol: string;
  trader: string;
  recipient: string;
  chainId: 421614;
  amountUnit: "base" | "collateral-usdc";
  collateralUsd: string;
  leverage: number;
  builderFeeBps: 0;
  delegate?: string;
  functionName: string;
  expectedData: Hex;
  requiredAllowanceUsd: string;
  notionalUsd: string;
  marketObservedAt: number;
  minimumBlock: string;
  positionId?: string;
  positionIndex?: number;
  positionSize?: string;
  orderIndex?: number;
  closePercentBps?: number;
  ownerOnly?: boolean;
  preview?: Record<string, unknown>;
}

export type OstiumPreparedAction = PreparedAction & { ostium: OstiumExecutionContext };
export interface OstiumDelegationPlan { trader: string; delegate: string; currentDelegate: string; chainId: 421614; contractAddress: string; transactions: EvmTransaction[]; expiresAt: number; alreadyActive: boolean }
export interface OstiumAllowancePlan { id: string; accountId: string; trader: string; chainId: 421614; token: string; spender: string; amountUsd: string; amountRaw: string; transaction: EvmTransaction; expiresAt: number; status: string }
type ExtraRequest = TradeRequest & { positionId?: string; amountUnit?: string; takeProfit?: string; stopLoss?: string; isDayTrade?: boolean };
const same = (left: string, right: string) => isAddressEqual(getAddress(left), getAddress(right));
const invalid = () => new WalletActionError("OSTIUM_CALL_MISMATCH", "The Ostium transaction does not match the reviewed testnet action.");

export function inspectPreparedOstiumAction(input: PreparedAction, mode: "owner" | "agent" = "owner"): OstiumPreparedAction {
  const prepared = input as OstiumPreparedAction, request = prepared.request as ExtraRequest, scope = prepared.ostium;
  if (!scope || String(request.venue) !== "ostium" || String(prepared.account.venue) !== "ostium" || prepared.kind !== "evm" || prepared.account.chainId !== OSTIUM_TESTNET.chainId || scope.chainId !== OSTIUM_TESTNET.chainId || request.accountId !== prepared.account.id || !same(prepared.account.ownerAddress, prepared.account.address) || !same(scope.trader, prepared.account.address) || !same(scope.recipient, scope.trader) || scope.builderFeeBps !== 0 || scope.symbol !== request.symbol || !Number.isSafeInteger(scope.pairId) || scope.pairId < 0 || scope.pairId > 65535 || prepared.expiresAt <= Date.now()) throw invalid();
  const transactions = prepared.transactions;
  if (!transactions?.length || transactions.length > 3) throw invalid();
  const native = transactions.at(-1)!;
  if (native.chainId !== OSTIUM_TESTNET.chainId || !same(native.to, OSTIUM_TESTNET.trading) || native.value !== "0") throw invalid();
  let decoded, data = native.data as Hex;
  try { decoded = decodeFunctionData({ abi: ostiumTradingAbi, data }); } catch { throw invalid(); }
  if (mode === "agent") {
    if (!scope.delegate || !prepared.account.agentAddress || !same(scope.delegate, prepared.account.agentAddress) || decoded.functionName !== "delegatedAction" || !same(decoded.args[0], scope.trader) || scope.ownerOnly) throw invalid();
    data = decoded.args[1];
    try { decoded = decodeFunctionData({ abi: ostiumTradingAbi, data }); } catch { throw invalid(); }
    if (transactions.length !== 1) throw invalid();
  } else if (decoded.functionName === "delegatedAction" || scope.delegate) throw invalid();
  if (decoded.functionName !== scope.functionName || scope.expectedData.toLowerCase() !== data.toLowerCase()) throw invalid();
  const pair = Number(scope.pairId), type = String(request.type);
  const args = decoded.args as readonly unknown[];
  const price = (value: string | undefined) => value === undefined || value === "0" ? 0n : exactTokenAmount(value, 18);
  const opening = ["market", "limit", "stop"].includes(type);
  if (opening) {
    if (decoded.functionName !== "openTrade" || request.amountUnit !== "collateral-usdc") throw invalid();
    const trade = args[0] as { collateral: bigint; trader: string; pairIndex: number; leverage: number; openPrice: bigint; buy: boolean; tp: bigint; sl: bigint; isDayTrade: boolean };
    const builder = args[1] as { builder: string; builderFee: number };
    if (trade.collateral !== exactTokenAmount(request.amount, 6) || !same(trade.trader, scope.trader) || trade.pairIndex !== pair || BigInt(trade.leverage) !== exactTokenAmount(String(request.leverage ?? 1), 2) || trade.openPrice !== price(request.price) || trade.buy !== (request.side === "buy") || trade.tp !== price(request.takeProfit) || trade.sl !== price(request.stopLoss) || trade.isDayTrade !== (request.isDayTrade ?? false) || !same(builder.builder, zeroAddress) || Number(builder.builderFee) !== 0 || Number(args[2]) !== ({ market: 0, limit: 1, stop: 2 } as Record<string, number>)[type] || BigInt(args[3] as bigint) !== (type === "market" ? BigInt(request.slippageBps) : 0n)) throw invalid();
  } else {
    const allowed: Record<string, string[]> = { close: ["closeTradeMarket"], reduce: ["closeTradeMarket"], cancel: ["cancelOpenLimitOrder", "openTradeMarketTimeout", "closeTradeMarketTimeout"], "stop-loss": ["updateSl"], "take-profit": ["updateTp"], "edit-order": ["updateOpenLimitOrder"], "add-collateral": ["topUpCollateral"], "remove-collateral": ["removeCollateral"] };
    if (!allowed[type]?.includes(decoded.functionName)) throw invalid();
    if (!decoded.functionName.endsWith("Timeout")) {
      if (Number(args[0]) !== pair || Number(args[1]) !== (type === "cancel" || type === "edit-order" ? scope.orderIndex : scope.positionIndex)) throw invalid();
    } else if (!request.orderId || !/^pending-(open|close):\d+$/.test(request.orderId) || BigInt(args[0] as bigint) !== BigInt(request.orderId.split(":")[1]!) || decoded.functionName === "closeTradeMarketTimeout" && args[1] !== false) throw invalid();
    if (type === "close" || type === "reduce") {
      if (!scope.positionId || request.positionId !== scope.positionId || !Number.isSafeInteger(scope.closePercentBps) || scope.closePercentBps! < 100 || scope.closePercentBps! > 10_000 || Number(args[2]) !== scope.closePercentBps || BigInt(args[3] as bigint) !== price(request.price) || BigInt(args[4] as bigint) !== BigInt(request.slippageBps)) throw invalid();
      if (!scope.positionSize || exactTokenAmount(request.amount, 18) !== exactTokenAmount(scope.positionSize, 18) * BigInt(scope.closePercentBps!) / 10_000n || type === "close" && scope.closePercentBps !== 10_000) throw invalid();
    }
    if (type === "stop-loss" || type === "take-profit") {
      if (!scope.positionId || request.positionId !== scope.positionId || BigInt(args[2] as bigint) !== price(type === "stop-loss" ? request.stopLoss ?? request.triggerPrice : request.takeProfit ?? request.triggerPrice)) throw invalid();
    }
    if (type === "edit-order" && (request.takeProfit === undefined || request.stopLoss === undefined || BigInt(args[2] as bigint) !== price(request.price) || BigInt(args[3] as bigint) !== price(request.takeProfit) || BigInt(args[4] as bigint) !== price(request.stopLoss))) throw invalid();
    if (type === "add-collateral" || type === "remove-collateral") {
      if (request.amountUnit !== "collateral-usdc" || request.positionId !== scope.positionId || BigInt(args[2] as bigint) !== exactTokenAmount(request.amount, 6) || mode === "agent" && type === "remove-collateral") throw invalid();
    }
  }
  const approvals = transactions.slice(0, -1);
  if (approvals.length && (!["market", "limit", "stop", "add-collateral", "close", "reduce", "remove-collateral"].includes(type) || decimalToPositiveAllowance(scope.requiredAllowanceUsd) <= 0n)) throw invalid();
  for (const [index, transaction] of approvals.entries()) {
    if (mode === "agent" || transaction.chainId !== OSTIUM_TESTNET.chainId || transaction.value !== "0" || !same(transaction.to, OSTIUM_TESTNET.usdc)) throw invalid();
    const approval = decodeFunctionData({ abi: erc20Abi, data: transaction.data as Hex });
    const expectedAmount = approvals.length === 2 && index === 0 ? 0n : exactTokenAmount(scope.requiredAllowanceUsd, 6);
    if (approval.functionName !== "approve" || !same(approval.args[0], OSTIUM_TESTNET.storage) || approval.args[1] !== expectedAmount) throw invalid();
  }
  return prepared;
}

function decimalToPositiveAllowance(value: string) { return value === "0" ? 0n : exactTokenAmount(value, 6); }

export function inspectOstiumOwnerPlan(account: TradingAccount, plan: OstiumDelegationPlan | OstiumAllowancePlan, purpose: "grant" | "revoke" | "allowance") {
  if (account.venue !== "ostium" || account.chainId !== 421614 || account.smartAccountAddress || !same(account.ownerAddress, account.address) || plan.chainId !== 421614 || !same(plan.trader, account.ownerAddress) || plan.expiresAt <= Date.now()) throw invalid();
  if (purpose === "allowance") {
    const approval = plan as OstiumAllowancePlan, amount = exactTokenAmount(approval.amountUsd, 6);
    if (approval.accountId !== account.id || approval.status !== "prepared" || !approval.id || amount.toString() !== approval.amountRaw || amount > 2_000_000_000_000n || !same(approval.token, OSTIUM_TESTNET.usdc) || !same(approval.spender, OSTIUM_TESTNET.storage) || !same(approval.transaction.to, OSTIUM_TESTNET.usdc) || approval.transaction.chainId !== 421614 || approval.transaction.value !== "0" || approval.transaction.data.toLowerCase() !== encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OSTIUM_TESTNET.storage, amount] }).toLowerCase()) throw invalid();
    return;
  }
  const grant = plan as OstiumDelegationPlan;
  if (!same(grant.contractAddress, OSTIUM_TESTNET.trading) || grant.transactions.length > 1 || grant.alreadyActive !== (grant.transactions.length === 0)) throw invalid();
  if (purpose === "grant" ? !account.agentAddress || !same(grant.delegate, account.agentAddress) || same(grant.delegate, zeroAddress) || !same(grant.currentDelegate, zeroAddress) && !same(grant.currentDelegate, grant.delegate) : !same(grant.delegate, zeroAddress)) throw invalid();
  const expected = purpose === "grant" ? encodeFunctionData({ abi: ostiumTradingAbi, functionName: "setDelegate", args: [getAddress(grant.delegate)] }) : encodeFunctionData({ abi: ostiumTradingAbi, functionName: "removeDelegate" });
  if (grant.transactions.some(transaction => transaction.chainId !== 421614 || transaction.value !== "0" || !same(transaction.to, OSTIUM_TESTNET.trading) || transaction.data.toLowerCase() !== expected.toLowerCase())) throw invalid();
}
