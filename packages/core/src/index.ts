import { z } from "zod";

export const venueSchema = z.enum(["uniswap", "hyperliquid", "ostium"]);
export type Venue = z.infer<typeof venueSchema>;
export const tradeActionSchema = z.enum(["swap", "market", "limit", "stop", "cancel", "reduce", "close", "stop-loss", "take-profit", "edit-order", "add-collateral", "remove-collateral"]);
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid wallet address");
export const decimalSchema = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Use a positive decimal amount");
export const positiveDecimalSchema = decimalSchema.refine(value => /[1-9]/.test(value), "Amount must be greater than zero");

export const tradeRequestSchema = z.object({
  accountId: z.string().min(1).max(100),
  venue: venueSchema,
  type: tradeActionSchema,
  symbol: z.string().min(1).max(50),
  side: z.enum(["buy", "sell"]),
  amount: decimalSchema,
  price: positiveDecimalSchema.optional(),
  triggerPrice: decimalSchema.optional(),
  slippageBps: z.number().int().min(1).max(500).default(50),
  tokenIn: addressSchema.optional(),
  tokenOut: addressSchema.optional(),
  tokenInDecimals: z.number().int().min(0).max(36).optional(),
  tokenOutDecimals: z.number().int().min(0).max(36).optional(),
  feeTier: z.union([z.literal(100), z.literal(500), z.literal(3000), z.literal(10000)]).optional(),
  nativeInput: z.boolean().optional(),
  orderId: z.string().max(100).optional(),
  positionId: z.string().min(1).max(100).optional(),
  amountUnit: z.enum(["base", "collateral-usdc"]).optional(),
  takeProfit: decimalSchema.optional(),
  stopLoss: decimalSchema.optional(),
  isDayTrade: z.boolean().optional(),
  reduceOnly: z.boolean().default(false),
  leverage: z.number().finite().min(1).max(1000).refine(value=>/^\d+(?:\.\d{1,2})?$/.test(String(value)),"Leverage supports at most two decimal places").optional(),
  mode: z.enum(["manual", "agent"]).default("manual"),
}).strict().superRefine((value,context)=>{
  if(!/[1-9]/.test(value.amount)&&!(value.venue==="ostium"&&value.type==="cancel"&&value.orderId&&value.amountUnit==="base"))context.addIssue({code:"custom",message:"Amount must be greater than zero unless cancelling an exact native Ostium order.",path:["amount"]});
  if(value.nativeInput&&(value.venue!=="uniswap"||value.type!=="swap"||value.side!=="sell"||value.symbol.toUpperCase()!=="WETH/USDC"))context.addIssue({code:"custom",message:"Native ETH input supports only selling ETH into the WETH/USDC spot pool. Buying returns WETH, not native ETH.",path:["nativeInput"]});
  if(value.venue!=="ostium"){
    if(["stop","edit-order","add-collateral","remove-collateral"].includes(value.type)||[value.positionId,value.amountUnit,value.takeProfit,value.stopLoss,value.isDayTrade].some(field=>field!==undefined))context.addIssue({code:"custom",message:"These action fields are supported only on Ostium."});
    if(value.leverage!==undefined&&(!Number.isInteger(value.leverage)||value.leverage>20))context.addIssue({code:"custom",message:"This venue supports integer leverage up to 20.",path:["leverage"]});
    if(value.triggerPrice!==undefined&&!/[1-9]/.test(value.triggerPrice))context.addIssue({code:"custom",message:"Use a positive trigger price.",path:["triggerPrice"]});
    return;
  }
  if(value.type==="swap"||[value.tokenIn,value.tokenOut,value.tokenInDecimals,value.tokenOutDecimals,value.feeTier,value.nativeInput].some(field=>field!==undefined))context.addIssue({code:"custom",message:"Ostium uses its native USDC trading workflow, not arbitrary token or swap fields."});
  if(["market","limit","stop"].includes(value.type)&&(value.amountUnit!=="collateral-usdc"||value.leverage===undefined))context.addIssue({code:"custom",message:"Ostium entries require explicit USDC collateral units and leverage."});
  if(["limit","stop","edit-order"].includes(value.type)&&!value.price)context.addIssue({code:"custom",message:"This Ostium order requires an explicit price.",path:["price"]});
  if(["close","reduce","stop-loss","take-profit","add-collateral","remove-collateral"].includes(value.type)&&!value.positionId)context.addIssue({code:"custom",message:"Select the exact native position ID.",path:["positionId"]});
  if(["close","reduce"].includes(value.type)&&value.amountUnit!=="base")context.addIssue({code:"custom",message:"Ostium exits use explicit base-asset size units.",path:["amountUnit"]});
  if(["add-collateral","remove-collateral","edit-order"].includes(value.type)&&value.amountUnit!=="collateral-usdc")context.addIssue({code:"custom",message:"Use explicit USDC collateral units for this Ostium action.",path:["amountUnit"]});
  if(["cancel","edit-order"].includes(value.type)&&!value.orderId)context.addIssue({code:"custom",message:"Select the exact native order ID.",path:["orderId"]});
  if(value.type==="edit-order"&&(value.takeProfit===undefined||value.stopLoss===undefined))context.addIssue({code:"custom",message:"Review both protective levels when editing an order. Zero explicitly clears a level."});
  if(value.type==="stop-loss"||value.type==="take-profit"){
    const level=value.type==="stop-loss"?value.stopLoss:value.takeProfit;
    if(level===undefined&&value.triggerPrice===undefined||level!==undefined&&value.triggerPrice!==undefined&&level!==value.triggerPrice)context.addIssue({code:"custom",message:"Provide one unambiguous protective level; zero explicitly clears it."});
    if(value.type==="stop-loss"&&value.takeProfit!==undefined||value.type==="take-profit"&&value.stopLoss!==undefined)context.addIssue({code:"custom",message:"Change only the selected protective level in this action."});
  }
});
export type TradeRequest = z.infer<typeof tradeRequestSchema>;
export type ActionInput = TradeRequest;

export interface User {
  id: string;
  address: string;
  createdAt: number;
}

export interface TradingAccount {
  id: string;
  userId: string;
  venue: Venue;
  address: string;
  ownerAddress: string;
  chainId: number;
  agentAddress?: string;
  smartAccountAddress?: string;
  status: "connected" | "authorized" | "revoked" | "unsupported";
  controlRevision: number;
  createdAt?: number;
}

export interface OstiumMarketSchedule {
  id: number;
  alwaysOpen?: boolean;
  timezone?: string;
  openingHours?: string[];
}

export interface OstiumMarketData {
  minLeverage: number;
  overnightMaxLeverage: number;
  marketOpen: boolean;
  oracleFeeUsdc: string;
  openFeeBps: number;
  // Signed eight-hour percentages: negative earns, positive pays.
  rolloverRate: { long: string; short: string };
  // Current combined long and short exposure in USD.
  openInterest: string;
  schedule?: OstiumMarketSchedule;
}

export interface Market extends Partial<OstiumMarketData> {
  venue: Venue;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  midPrice: string;
  change24h?: number;
  volume24h?: string;
  sizeDecimals?: number;
  maxLeverage?: number;
  pairId?: number;
  category?: string;
  tradable?: boolean;
  unavailableReason?: string;
  observedAt: number;
}

export type OstiumMarket = Market & OstiumMarketData & { venue: "ostium" };

export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Balance {
  symbol: string;
  amount: string;
  usdValue?: string;
  tokenAddress?: string;
  decimals?: number;
  accountId: string;
}

export interface Position {
  id: string;
  accountId: string;
  venue: Venue;
  symbol: string;
  side: "long" | "short";
  size: string;
  entryPrice: string;
  markPrice?: string;
  unrealizedPnl: string;
  liquidationPrice?: string;
  leverage?: number;
  collateralUsd?: string;
  notionalUsd?: string;
  positionId?: string;
  takeProfit?: string;
  stopLoss?: string;
  isDayTrade?: boolean;
  observedAt: number;
}

export interface OpenOrder {
  id: string;
  accountId: string;
  venue: Venue;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  size: string;
  price?: string;
  collateralUsd?: string;
  notionalUsd?: string;
  leverage?: number;
  amountUnit?: "base" | "collateral-usdc";
  takeProfit?: string;
  stopLoss?: string;
  reduceOnly: boolean;
  createdAt: number;
}

export interface Portfolio {
  accounts: TradingAccount[];
  balances: Balance[];
  positions: Position[];
  orders: OpenOrder[];
  totalEquityUsd?: string;
  observedAt: number;
  errors?: Array<{ accountId: string; message: string }>;
}

export interface EvmTransaction {
  to: string;
  data: string;
  value: string;
  chainId: number;
  label?: string;
}

export interface HyperliquidOperation {
  method: "order" | "cancel" | "cancelByCloid" | "updateLeverage";
  params: Record<string, unknown>;
}

export interface ActionQuote {
  amountIn: string;
  amountOut: string;
  minimumOut?: string;
  fee?: string;
  priceImpactBps?: number;
  observedAt: number;
}

export interface PreparedAction {
  id: string;
  request: TradeRequest;
  account: TradingAccount;
  kind: "evm" | "hyperliquid" | "user-operation";
  transactions?: EvmTransaction[];
  hyperliquid?: HyperliquidOperation;
  ostium?: OstiumExecution;
  quote?: ActionQuote;
  expiresAt: number;
  controlRevision: number;
  warnings?: string[];
}

export interface OstiumExecution {
  trader: string; recipient: string; chainId: 421614; pairId: number; symbol: string;
  positionId?: string; positionIndex?: number; orderIndex?: number; positionSize?: string; closePercentBps?: number;
  amountUnit: "base" | "collateral-usdc"; requiredAllowanceUsd: string; collateralUsd: string; notionalUsd: string;
  leverage: number; builderFeeBps: 0; marketObservedAt: number; minimumBlock: string; functionName: string; expectedData: `0x${string}`;
  delegate?: string; ownerOnly?: boolean; preview?: Record<string, unknown>;
}

export const OSTIUM_DELEGATION_NOTICE = "Ostium native delegation has no onchain expiry or Orcus asset, size or leverage caps. The raw delegate key can remove collateral and charge builder fees. Orcus restricts its own signer, but these limits are application-enforced. Only the owner can change native delegation, and payouts return to the owner's trading account.";
export const ostiumDelegationAcknowledgementSchema = z.object({
  version: z.literal("ostium-native-delegation-v1"), chainId: z.literal(421614), trader: addressSchema, agentAddress: addressSchema,
  nativeNoExpiry: z.literal(true), applicationLimitsOnly: z.literal(true), delegateCanRemoveCollateral: z.literal(true), delegateCanChargeBuilderFees: z.literal(true), ownerOnlyPermissionChanges: z.literal(true), payoutsToOwner: z.literal(true),
}).strict();
export type OstiumDelegationAcknowledgement = z.infer<typeof ostiumDelegationAcknowledgementSchema>;

export type ActionStatus = "prepared" | "awaiting-approval" | "submitting" | "submitted-unknown" | "pending" | "partially-filled" | "confirmed" | "rejected" | "cancelled";
export interface ActionRecord {
  id: string;
  userId: string;
  accountId: string;
  request: TradeRequest;
  status: ActionStatus;
  initiator: "manual" | "agent" | "automation";
  prepared?: PreparedAction;
  transactionHash?: string;
  userOperationHash?: string;
  orderId?: string;
  providerRequestId?: string;
  approvals?: ActionApprovalStep[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ActionApprovalStep {
  index: number; transactionHash?: string; amountUsd: string; token: string; spender: string;
  status: "submitting" | "pending" | "confirmed" | "rejected" | "submitted-unknown"; updatedAt: number;
}

export interface OstiumAllowanceIntent {
  id: string; accountId: string; trader: string; chainId: 421614; token: string; spender: string;
  amountUsd: string; amountRaw: string; transaction: EvmTransaction; expiresAt: number; notBefore: number; minimumBlock?: string;
  status: "prepared" | "submitting" | "pending" | "submitted-unknown" | "confirmed" | "rejected" | "cancelled";
  transactionHash?: string; error?: string; createdAt: number; updatedAt: number;
}

export interface AgentProfile {
  id: string;
  userId: string;
  name: string;
  operatingAddress: string;
  paused: boolean;
  mode: "approval-required" | "autonomous";
  preferences: string;
  privateInferenceRequired?: boolean;
  privateVerification?: "independent-gateway" | "gateway-reported";
}

export interface AgentPermission {
  id: string;
  accountId: string;
  agentAddress: string;
  allowedSymbols: string[];
  allowedActions: TradeRequest["type"][];
  maxTradeUsd: string;
  maxCollateralUsd?: string;
  maxLeverage?: number;
  expiresAt: number;
  status: "pending" | "active" | "revoked" | "expired";
  enforcement: "account" | "application";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  requestId?: string;
  proposedAction?: TradeRequest;
  automationProposal?: unknown;
  actionId?: string;
  privacy?: "unverified" | "independently-attested-private" | "gateway-reported-private";
  privacyEvidence?: unknown;
  toolSteps?: Array<{ name: string; ok: boolean; observedAt: number; requestId?: string }>;
}

export interface AgentRequest {
  id: string;
  requestId: string;
  runId: string;
  userMessageId: string;
  message: string;
  accountId?: string;
  autonomous: boolean;
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  stage: string;
  tool?: string;
  modelCalls: number;
  toolCalls: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  startedAt?: number;
  heartbeatAt?: number;
  completedAt?: number;
  response?: ChatMessage;
  actionId?: string;
  errorCode?: string;
  error?: string;
}

export interface Automation {
  id: string;
  userId: string;
  accountId: string;
  name: string;
  instruction: string;
  kind?: "trade" | "alert";
  request?: TradeRequest;
  intervalSeconds: number;
  status: "active" | "paused" | "expired" | "insufficient-budget" | "failed";
  nextRunAt: number;
  policyVersion: number;
  lastEvaluation?: CreEvaluation;
  expiresAt?: number;
  error?: string;
  createdAt: number;
}

export interface CreEvaluation {
  id: string;
  automationId: string;
  accountId: string;
  decision: "allow" | "reject" | "no-action";
  reason: string;
  source: "local-simulation" | "hosted";
  observedAt: number;
  expiresAt: number;
  controlRevision: number;
  requestId?: string;
  transactionHash?: string;
}

export interface OperatingBudget {
  operatingAddress: string;
  limitUsd: string;
  spentUsd: string;
  reservedUsd: string;
  availableUsd: string;
  computeCredits?: string;
  computeBalanceStatus: "verified" | "unavailable" | "unconfigured";
  replenishmentStatus: "idle" | "pending" | "confirmed" | "failed" | "unconfigured";
  warning?: string;
  providerBalance?: {
    status: "verified" | "unavailable" | "unconfigured";
    balance?: string;
    balanceNeurons?: string;
    depositBalanceNeurons?: string;
    accountAddress?: string;
    unit?: "0G" | "USD" | "unknown";
    currency?: "0g" | "usd";
    chainId?: number;
    observedAt?: number;
    message: string;
  };
  computeBalanceScope?: "configured-provider-account";
  storagePayer?: { enabled?: boolean; configured: boolean; costBearer: "operator" | "agent"; userNeeds0G: boolean; payerAddress?: string; limits?: { maxGas0G: string; maxStorageFee0G: string }; dailyCap0G?: string; dailySpent0G?: string; reserved0G?: string; pending?: boolean; message: string };
  expenses?: Array<{ id: string; reference: string; status: string; amountUsd: string; created_at: number; evidence?: unknown }>;
  nativeExpenses?: Array<{ id: string; kind: "storage"; currency: "0g"; chainId: 16602; status: "confirmed" | "reverted" | "submitted-unknown" | "not-submitted"; transactionHash: string; gasPaidWei?: string; storageFeeWei?: string; totalSpentWei?: string }>;
}

export interface CapabilityStatus {
  configured: boolean;
  ready: boolean;
  message: string;
}
export interface HealthStatus {
  mode: "testnet";
  compute: CapabilityStatus;
  storage: CapabilityStatus;
  uniswap: CapabilityStatus;
  hyperliquid: CapabilityStatus;
  ostium?: CapabilityStatus;
  cre: CapabilityStatus;
  signing?: CapabilityStatus;
}

export type ApiResponse<T> = { data: T } | { error: { code: string; message: string } };

export class OrcusError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "OrcusError";
  }
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

export function formatAmount(value: string | number | undefined, maximumFractionDigits = 4): string {
  if (value === undefined || value === "") return "Not available";
  const number = Number(value);
  if (!Number.isFinite(number)) return "Not available";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(number);
}
