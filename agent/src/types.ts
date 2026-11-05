import type { Balance, OpenOrder, Position, PreparedAction, TradingAccount, TradeRequest } from "@orcus/core";

export interface AccountPortfolio {
  accountId: string;
  balances: Balance[];
  positions: Position[];
  orders: OpenOrder[];
  equityUsd?: string;
  freeCollateralUsd?: string;
  observedAt: number;
  errors?: string[];
}

export interface SubmissionResult {
  status: "pending" | "confirmed" | "partially-filled" | "submitted-unknown" | "rejected" | "cancelled";
  txHash?: string;
  orderId?: string;
  evidence?: Record<string, unknown>;
}

export interface PlannerContext {
  account?: TradingAccount;
  accounts?: TradingAccount[];
  portfolio?: unknown;
  markets?: unknown;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  memory?: unknown;
  requirePrivate?: boolean;
  [key: string]: unknown;
}

export type { PreparedAction, TradingAccount, TradeRequest };
