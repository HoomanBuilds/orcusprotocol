import { formatUnits, parseUnits } from "viem";
import type { ActionRecord, AgentModelCatalog, AgentProfile, AgentRequest, Automation, Balance, ChatMessage, OperatingBudget, OstiumAllowanceIntent, Portfolio, Position, TradeRequest, TradingAccount } from "@orcus/core";
import type { AgentData, Session } from "./use-workspace";
import type { FundingSnapshot, PaymentSnapshot } from "./workspace-model";

export const DEMO_OWNER_ADDRESS = "0xDe00000000000000000000000000000000000001";
export const DEMO_OPERATING_ADDRESS = "0xDe00000000000000000000000000000000000002";
export const DEMO_OBSERVED_AT = Date.UTC(2026, 10, 6, 12);
const userId = "demo-owner";
const sampleSigner = "0xDe00000000000000000000000000000000000003";
const spotAddress = "0xDe00000000000000000000000000000000000004";
const sumUsd = (amounts: string[]) => formatUnits(amounts.reduce((total, amount) => total + parseUnits(amount, 6), 0n), 6);
const multiply = (amount: string, price: string) => formatUnits(parseUnits(amount, 6) * parseUnits(price, 6) / 1_000_000n, 6);

export function createDemoData(_now?: number) {
  const timestamp = DEMO_OBSERVED_AT;
  const accounts: TradingAccount[] = [
    { id: "demo-hyperliquid", userId, venue: "hyperliquid", address: DEMO_OWNER_ADDRESS, ownerAddress: DEMO_OWNER_ADDRESS, chainId: 421614, agentAddress: sampleSigner, status: "connected", controlRevision: 0, createdAt: timestamp - 86_400_000 },
    { id: "demo-uniswap", userId, venue: "uniswap", address: spotAddress, smartAccountAddress: spotAddress, ownerAddress: DEMO_OWNER_ADDRESS, chainId: 11155111, agentAddress: sampleSigner, status: "connected", controlRevision: 0, createdAt: timestamp - 86_400_000 },
    { id: "demo-ostium", userId, venue: "ostium", address: DEMO_OWNER_ADDRESS, ownerAddress: DEMO_OWNER_ADDRESS, chainId: 421614, agentAddress: sampleSigner, status: "connected", controlRevision: 0, createdAt: timestamp - 86_400_000 },
  ];
  const positions: Position[] = [
    { id: "demo-position-eth", accountId: "demo-hyperliquid", venue: "hyperliquid", symbol: "ETH", side: "long", size: "1.5", entryPrice: "3200", markPrice: "3320", unrealizedPnl: multiply("1.5", "120"), leverage: 3, observedAt: timestamp },
    { id: "demo-position-btc", accountId: "demo-hyperliquid", venue: "hyperliquid", symbol: "BTC", side: "short", size: "0.05", entryPrice: "96000", markPrice: "96100", unrealizedPnl: multiply("0.05", "-100"), leverage: 2, observedAt: timestamp },
    { id: "demo-position-gold", positionId: "demo-position-gold", accountId: "demo-ostium", venue: "ostium", symbol: "XAU/USD", side: "long", size: "2", entryPrice: "2650", markPrice: "2695", unrealizedPnl: multiply("2", "45"), collateralUsd: "1060", notionalUsd: multiply("2", "2695"), leverage: 5, stopLoss: "2600", takeProfit: "2800", isDayTrade: false, observedAt: timestamp },
  ];
  const hyperliquidEquity = sumUsd(["10000", ...positions.filter(position => position.venue === "hyperliquid").map(position => position.unrealizedPnl)]);
  const balances: Balance[] = [
    { accountId: "demo-hyperliquid", symbol: "USDC", amount: hyperliquidEquity, usdValue: hyperliquidEquity, decimals: 6 },
    { accountId: "demo-uniswap", symbol: "USDC", amount: "4500", usdValue: "4500", decimals: 6 },
    { accountId: "demo-uniswap", symbol: "WETH", amount: "1.2", usdValue: multiply("1.2", "3320"), decimals: 18 },
    { accountId: "demo-uniswap", symbol: "ETH", amount: "0.12", usdValue: multiply("0.12", "3320"), decimals: 18 },
    { accountId: "demo-ostium", symbol: "USDC", amount: "3000", usdValue: "3000", decimals: 6 },
    { accountId: "demo-ostium", symbol: "ETH", amount: "0.04", usdValue: multiply("0.04", "3320"), decimals: 18 },
  ];
  const portfolio: Portfolio = {
    accounts, balances, positions,
    orders: [
      { id: "demo-order-eth", accountId: "demo-hyperliquid", venue: "hyperliquid", symbol: "ETH", side: "buy", type: "limit", size: "0.4", price: "3150", reduceOnly: false, createdAt: timestamp - 3_600_000 },
      { id: "demo-order-btc", accountId: "demo-hyperliquid", venue: "hyperliquid", symbol: "BTC", side: "buy", type: "limit", size: "0.02", price: "93000", reduceOnly: true, createdAt: timestamp - 2_700_000 },
      { id: "demo-order-gold", accountId: "demo-ostium", venue: "ostium", symbol: "XAU/USD", side: "buy", type: "limit", size: "1", price: "2625", collateralUsd: "525", notionalUsd: "2625", leverage: 5, amountUnit: "base", reduceOnly: false, createdAt: timestamp - 1_800_000 },
    ],
    totalEquityUsd: sumUsd([...balances.map(balance => balance.usdValue ?? "0"), ...positions.filter(position => position.venue === "ostium").flatMap(position => [position.collateralUsd ?? "0", position.unrealizedPnl])]),
    observedAt: timestamp,
  };
  const agent: AgentProfile = { id: "demo-agent", userId, name: "Orcus", operatingAddress: DEMO_OPERATING_ADDRESS, paused: false, mode: "approval-required", preferences: "Sample preference: review risk before proposing trades. Keep compute spending separate from trading capital." };
  const session: Session = { user: { id: userId, address: DEMO_OWNER_ADDRESS, createdAt: timestamp - 86_400_000 }, agent, accounts };
  const trade = (request: Pick<TradeRequest, "accountId" | "venue" | "type" | "symbol" | "side" | "amount"> & Partial<TradeRequest>): TradeRequest => ({ slippageBps: 50, reduceOnly: false, mode: "manual", ...request });
  const swap = trade({ accountId: "demo-uniswap", venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "buy", amount: "150", mode: "agent" });
  const actions: ActionRecord[] = [
    { id: "demo-action-swap", userId, accountId: swap.accountId, request: swap, status: "awaiting-approval", initiator: "agent", createdAt: timestamp - 180_000, updatedAt: timestamp - 180_000 },
    { id: "demo-action-limit", userId, accountId: "demo-hyperliquid", request: trade({ accountId: "demo-hyperliquid", venue: "hyperliquid", type: "limit", symbol: "ETH", side: "buy", amount: "0.25", price: "3100" }), status: "cancelled", initiator: "manual", createdAt: timestamp - 7_200_000, updatedAt: timestamp - 6_900_000 },
  ];
  const messages: ChatMessage[] = [
    { id: "demo-message-risk-question", role: "user", content: "Review my positions across venues. Where is my largest exposure?", createdAt: timestamp - 600_000 },
    { id: "demo-message-risk-answer", role: "assistant", content: "Your sample portfolio has $15,175 in gross perpetual exposure across ETH, BTC and gold. Gold is the largest at $5,390, followed by ETH at $4,980. The BTC short is $4,805.\n\nUnrealized P&L is +$265. The trading account equity is $23,340.20, including spot holdings. Your agent's operating allowance is separate. These are fixed demo values, not a live risk assessment.", createdAt: timestamp - 570_000 },
    { id: "demo-message-plan-question", role: "user", content: "Plan a $150 WETH purchase and a price alert below $3,100. Let me review it first.", createdAt: timestamp - 240_000 },
    { id: "demo-message-plan-answer", role: "assistant", content: "The sample WETH purchase is ready to inspect in Activity. It uses 150 USDC from the Uniswap trading account, not the compute budget.\n\nThe ETH alert is saved as a paused example in Automations. A real purchase would require a fresh quote and your approval; the alert would require explicit activation.", actionId: "demo-action-swap", createdAt: timestamp - 180_000 },
  ];
  const agentData: AgentData = { agent, messages, permissions: [] };
  const requests: AgentRequest[] = [0, 1].map(index => ({
    id: `demo-request-${index + 1}`, requestId: `demo-request-${index + 1}`, runId: `demo-run-${index + 1}`, userMessageId: messages[index * 2].id,
    message: messages[index * 2].content, accountId: index === 0 ? "demo-hyperliquid" : "demo-uniswap", autonomous: false, status: "completed", stage: "Sample conversation", modelCalls: 0, toolCalls: 0,
    createdAt: messages[index * 2].createdAt, updatedAt: messages[index * 2 + 1].createdAt, completedAt: messages[index * 2 + 1].createdAt, expiresAt: timestamp, response: messages[index * 2 + 1],
  }));
  const automations: Automation[] = [
    { id: "demo-automation-alert", userId, accountId: "demo-hyperliquid", name: "ETH downside alert", instruction: "Sample rule: notify when ETH falls below $3,100.", kind: "alert", condition: { symbol: "ETH", operator: "below", price: "3100" }, intervalSeconds: 300, status: "paused", executionMode: "on-crossing", maxExecutions: 3, executionCount: 0, policySchemaVersion: 1, nextRunAt: 0, policyVersion: 1, createdAt: timestamp - 180_000 },
    { id: "demo-automation-scheduled", userId, accountId: "demo-uniswap", name: "Daily WETH allocation", instruction: "Sample rule: buy 150 USDC of WETH daily, up to four times.", kind: "trade", request: swap, intervalSeconds: 86400, status: "paused", executionMode: "recurring", maxExecutions: 4, executionCount: 0, policySchemaVersion: 1, nextRunAt: 0, policyVersion: 1, createdAt: timestamp - 3_600_000 },
  ];
  const expenses = [
    { id: "demo-expense-risk", reference: "Sample portfolio review", status: "settled", amountUsd: "1.6", created_at: timestamp - 570_000 },
    { id: "demo-expense-plan", reference: "Sample strategy planning", status: "settled", amountUsd: "0.8", created_at: timestamp - 180_000 },
  ];
  const spentUsd = sumUsd(expenses.map(expense => expense.amountUsd));
  const availableUsd = sumUsd(["25", `-${spentUsd}`, "-0.6"]);
  const budget: OperatingBudget = { operatingAddress: DEMO_OPERATING_ADDRESS, limitUsd: "25", spentUsd, reservedUsd: "0.6", availableUsd, computeBalanceStatus: "unconfigured", replenishmentStatus: "unconfigured", warning: "Sample operating allowance only. No provider credits, deposits or charges are verified.", providerBalance: { status: "unconfigured", message: "Provider balance is not connected in demo mode." }, expenses };
  const payments: PaymentSnapshot & { mode: "demo"; testOnly: true } = { configured: false, mode: "demo", testOnly: true, message: "Illustrative service-credit ledger. No payment was made.", credits: { paidUsd: "25", spentUsd, reservedUsd: "0.6", releasedUsd: "0", remainingUsd: availableUsd, refundedUsd: "0" }, intents: [] };
  const funding: FundingSnapshot & { policy: null; spent0G: string; reserved0G: string; available0G: string; warning: string } = { status: "unconfigured", policy: null, spent0G: "0", reserved0G: "0", available0G: "0", intents: [], warning: "Native compute deposits are disabled for the demo account." };
  const models: AgentModelCatalog = { defaultModelId: "", selectedModelId: "", catalogAvailable: false, warning: "Demo conversations are examples, not model output from an inference run.", models: [] };
  const memory = { notes: [{ id: "demo-memory-preference", kind: "preference" as const, content: "Ask before execution and keep operating costs separate from trading capital.", source: "sample", updatedAt: timestamp - 86_400_000 }], checkpointAvailable: false, warning: "Sample memory only. Nothing has been uploaded or attested." };
  return { metadata: { kind: "sample" as const, label: "Demo account", observedAt: timestamp, readOnly: true as const }, session, portfolio, agentData, actions, automations, budget, requests, payments, funding, ostiumAllowances: [] as OstiumAllowanceIntent[], models, memory, notifications: [] };
}

export type DemoWorkspaceData = ReturnType<typeof createDemoData>;
