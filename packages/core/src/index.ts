import { z } from "zod";

export const venueSchema = z.enum(["uniswap", "hyperliquid"]);
export type Venue = z.infer<typeof venueSchema>;
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid wallet address");
export const decimalSchema = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Use a positive decimal amount");
export const positiveDecimalSchema = decimalSchema.refine(value => /[1-9]/.test(value), "Amount must be greater than zero");

export const tradeRequestSchema = z.object({
  accountId: z.string().min(1).max(100),
  venue: venueSchema,
  type: z.enum(["swap", "market", "limit", "cancel", "reduce", "close", "stop-loss", "take-profit"]),
  symbol: z.string().min(1).max(50),
  side: z.enum(["buy", "sell"]),
  amount: positiveDecimalSchema,
  price: positiveDecimalSchema.optional(),
  triggerPrice: positiveDecimalSchema.optional(),
  slippageBps: z.number().int().min(1).max(500).default(50),
  tokenIn: addressSchema.optional(),
  tokenOut: addressSchema.optional(),
  tokenInDecimals: z.number().int().min(0).max(36).optional(),
  tokenOutDecimals: z.number().int().min(0).max(36).optional(),
  feeTier: z.union([z.literal(100), z.literal(500), z.literal(3000), z.literal(10000)]).optional(),
  orderId: z.string().max(100).optional(),
  reduceOnly: z.boolean().default(false),
  leverage: z.number().int().min(1).max(20).optional(),
  mode: z.enum(["manual", "agent"]).default("manual"),
}).strict();
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

export interface Market {
  venue: Venue;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  midPrice: string;
  change24h?: number;
  volume24h?: string;
  sizeDecimals?: number;
  maxLeverage?: number;
  observedAt: number;
}

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
  quote?: ActionQuote;
  expiresAt: number;
  controlRevision: number;
  warnings?: string[];
}

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
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentProfile {
  id: string;
  userId: string;
  name: string;
  operatingAddress: string;
  paused: boolean;
  mode: "approval-required" | "autonomous";
  preferences: string;
}

export interface AgentPermission {
  id: string;
  accountId: string;
  agentAddress: string;
  allowedSymbols: string[];
  allowedActions: TradeRequest["type"][];
  maxTradeUsd: string;
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
    unit?: "0G" | "unknown";
    message: string;
  };
  computeBalanceScope?: "configured-provider-account";
  expenses?: Array<{ id: string; reference: string; status: string; amountUsd: string; created_at: number; evidence?: unknown }>;
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
