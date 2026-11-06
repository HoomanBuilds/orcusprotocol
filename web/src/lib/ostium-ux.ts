import { ostiumDelegationAcknowledgementSchema, tradeRequestSchema, type Market, type OpenOrder, type Position, type TradeRequest, type TradingAccount } from "@orcus/core";
import { formatUnits, parseUnits } from "viem";

export interface OstiumEntryDraft {
  type: "market" | "limit" | "stop";
  side: "buy" | "sell";
  amount: string;
  leverage: string;
  price: string;
  takeProfit: string;
  stopLoss: string;
  slippage: string;
  isDayTrade: boolean;
}

export function ostiumEntryRequest(account: TradingAccount, market: Market | undefined, draft: OstiumEntryDraft): TradeRequest {
  if (account.venue !== "ostium" || account.chainId !== 421614 || !market || market.venue !== "ostium" || market.tradable !== true || !market.midPrice) throw new Error("Choose an available Ostium testnet market before reviewing an entry.");
  const leverage = Number(draft.leverage);
  if (!Number.isFinite(leverage) || market.minLeverage !== undefined && leverage < market.minLeverage || market.maxLeverage !== undefined && leverage > market.maxLeverage) throw new Error("Leverage is outside this market's current limits.");
  if (!draft.isDayTrade && market.overnightMaxLeverage !== undefined && market.overnightMaxLeverage > 0 && leverage > market.overnightMaxLeverage) throw new Error("This leverage requires a day trade. Review the market's overnight limit.");
  return tradeRequestSchema.parse({ accountId: account.id, venue: "ostium", type: draft.type, symbol: market.symbol, side: draft.side, amount: draft.amount, amountUnit: "collateral-usdc", leverage, isDayTrade: draft.isDayTrade, slippageBps: Math.round(Number(draft.slippage) * 100), reduceOnly: false, mode: "manual", ...(draft.type !== "market" ? { price: draft.price } : {}), ...(draft.takeProfit.trim() ? { takeProfit: draft.takeProfit.trim() } : {}), ...(draft.stopLoss.trim() ? { stopLoss: draft.stopLoss.trim() } : {}) });
}

export function positionSizeAtPercent(size: string, percentage: number) {
  if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) throw new Error("Choose a reduction between 1 and 100 percent.");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(size)) throw new Error("The recorded position size is unavailable.");
  const reduced = parseUnits(size, 18) * BigInt(percentage) / 100n;
  if (reduced <= 0n) throw new Error("This reduction is below the position's supported precision.");
  return formatUnits(reduced, 18);
}

export function ostiumPositionRequest(position: Position, type: "close" | "reduce" | "stop-loss" | "take-profit" | "add-collateral" | "remove-collateral", value = "", percentage = 50): TradeRequest {
  if (position.venue !== "ostium") throw new Error("Select an Ostium position.");
  const collateral = type === "add-collateral" || type === "remove-collateral";
  return tradeRequestSchema.parse({ accountId: position.accountId, venue: "ostium", type, symbol: position.symbol, positionId: position.positionId ?? position.id, side: position.side === "long" ? "sell" : "buy", amount: collateral ? value : type === "reduce" ? positionSizeAtPercent(position.size, percentage) : position.size, amountUnit: collateral ? "collateral-usdc" : "base", slippageBps: 50, reduceOnly: type === "close" || type === "reduce", mode: "manual", ...(type === "stop-loss" ? { stopLoss: value } : {}), ...(type === "take-profit" ? { takeProfit: value } : {}) });
}

export function ostiumOrderRequest(order: OpenOrder, edit?: { price: string; takeProfit: string; stopLoss: string }): TradeRequest {
  if (order.venue !== "ostium") throw new Error("Select an Ostium order.");
  if (edit && order.id.startsWith("pending-")) throw new Error("A pending oracle order cannot be edited as a resting entry.");
  if (edit && (!order.collateralUsd || Number(order.collateralUsd) <= 0)) throw new Error("The order's collateral amount is unavailable. Refresh before editing.");
  return tradeRequestSchema.parse({ accountId: order.accountId, venue: "ostium", type: edit ? "edit-order" : "cancel", symbol: order.symbol, orderId: order.id, side: order.side, amount: edit ? order.collateralUsd! : order.size, amountUnit: edit ? "collateral-usdc" : "base", slippageBps: 50, reduceOnly: false, mode: "manual", ...(edit ?? {}) });
}

export function ostiumAcknowledgement(account: TradingAccount, agentAddress: string) {
  return ostiumDelegationAcknowledgementSchema.parse({ version: "ostium-native-delegation-v1", chainId: 421614, trader: account.ownerAddress, agentAddress, nativeNoExpiry: true, applicationLimitsOnly: true, delegateCanRemoveCollateral: true, delegateCanChargeBuilderFees: true, ownerOnlyPermissionChanges: true, payoutsToOwner: true });
}
