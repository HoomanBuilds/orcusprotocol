import { DynamicStructuredTool } from "@langchain/core/tools";
import { tradeRequestSchema, type TradingAccount, type Venue } from "@orcus/core";
import { z } from "zod";
import { compactObservation } from "../memory/context";
import { sma, rsi, realizedVolatility } from "../strategy/indicators";
import { getHyperliquidCandles, getHyperliquidMarkets, getHyperliquidPortfolio } from "../venues/hyperliquid";
import { getUniswapMarkets, getUniswapPortfolio } from "../venues/uniswap";
import type { AgentContext } from "./types";
import { automationProposalSchema } from "./automation";
import { resolveToolProfile, selectProfileTools } from "./tool-profiles";
import { rejectCredentialMaterial } from "./input-guard";

export interface AgentTool { name: string; description: string; arguments: string; run(input: unknown): Promise<unknown> }
const venueSchema = z.enum(["uniswap", "hyperliquid"]);

export function buildAgentTools(context: AgentContext, latestMessage: string) {
  const profile = resolveToolProfile(context.toolProfile);
  const accounts = context.accounts ?? (context.account ? [context.account] : []);
  const registry = new Map<string, AgentTool>();
  const accountById = (id: string): TradingAccount => {
    const account = accounts.find(item => item.id === id);
    if (!account) throw new Error("This account is not connected to the current personal agent.");
    return account;
  };
  const checkVenue = (venue: Venue) => {
    if (accounts.length && !accounts.some(account => account.venue === venue)) throw new Error("This venue is not connected to the current personal agent.");
    return venue;
  };
  const add = (name: string, description: string, argumentsDescription: string, schema: z.ZodObject, invoke: (input: Record<string, unknown>) => Promise<unknown>) => {
    const structured = new DynamicStructuredTool({ name, description, schema, func: async input => compactObservation(await invoke(input as Record<string, unknown>)) });
    registry.set(name, { name, description, arguments: argumentsDescription, run: async input => structured.invoke(schema.parse(input)) });
  };
  add("read_markets", "Read current market prices from a connected venue. No balances or trades are inferred.", "{venue:'hyperliquid'|'uniswap',symbols?:string[]}", z.object({ venue: venueSchema, symbols: z.array(z.string().max(40)).max(8).optional() }).strict(), async input => {
    const venue = checkVenue(input.venue as Venue);
    const markets = await (venue === "uniswap" ? getUniswapMarkets() : getHyperliquidMarkets());
    const symbols = input.symbols as string[] | undefined;
    return markets.filter(market => !symbols?.length || symbols.some(symbol => market.symbol.toLowerCase() === symbol.toLowerCase() || market.baseAsset.toLowerCase() === symbol.toLowerCase())).slice(0, 20);
  });
  add("read_portfolio", "Fetch actual balances, open positions and orders for an owned connected account.", "{accountId:string}", z.object({ accountId: z.string().min(1).max(100) }).strict(), async input => {
    const account = accountById(String(input.accountId));
    return account.venue === "uniswap" ? getUniswapPortfolio(account) : getHyperliquidPortfolio(account);
  });
  const candlesSchema = z.object({ venue: venueSchema, symbol: z.string().min(1).max(40), interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("1h"), limit: z.number().int().min(20).max(96).default(48) }).strict();
  add("analyze_market", "Read real venue candles and calculate RSI, moving averages and volatility. This is historical analysis, not guaranteed profit.", "{venue:'hyperliquid',symbol:string,interval?:'1m'|'5m'|'15m'|'1h'|'4h'|'1d',limit?:20..96}", candlesSchema, async input => {
    const parsed = candlesSchema.parse(input);
    checkVenue(parsed.venue);
    if (parsed.venue !== "hyperliquid") throw new Error("Historical Sepolia spot candles are not configured; use read_markets for a real spot quote.");
    const candles = await getHyperliquidCandles(parsed);
    const closes = candles.map(candle => candle.close);
    return { symbol: parsed.symbol, interval: parsed.interval, candleCount: closes.length, lastCandleTime: candles.at(-1)?.time, lastClose: closes.at(-1), rsi14: rsi(closes, 14), sma20: sma(closes, 20), volatilityPercent: realizedVolatility(closes), warning: "Indicators describe supplied historical candles and do not predict returns." };
  });
  add("search_memory", "Retrieve relevant notes/preferences from this user's durable personal memory.", "{query:string,limit?:1..8}", z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(8).default(5) }).strict(), async input => {
    if (!context.memoryStore) return { available: false, message: "Durable memory is not configured for this invocation." };
    return context.memoryStore.search(String(input.query), Number(input.limit));
  });
  let remembered = false;
  add("remember_preference", "Remember an explicitly requested user preference, never secrets or inferred financial facts.", "{content:string,sourceQuote:string,kind?:'note'|'preference',importance?:0..1}", z.object({ content: z.string().min(1).max(1000), sourceQuote: z.string().min(5).max(1000), kind: z.enum(["note", "preference"]).default("preference"), importance: z.number().min(0).max(1).default(0.5) }).strict(), async input => {
    if (!context.memoryStore) throw new Error("Durable personal memory is not configured.");
    if (remembered || !/\b(?:remember|save|keep|store|always|prefer)\b/i.test(latestMessage) || !latestMessage.includes(String(input.sourceQuote))) throw new Error("Memory writes require an explicit request and a quote from the current user message.");
    rejectCredentialMaterial(String(input.content), "MEMORY_SECRET_REJECTED");
    remembered = true;
    return context.memoryStore.remember({ content: String(input.content), kind: input.kind as "note" | "preference", importance: Math.round(Number(input.importance) * 100) });
  });
  add("forget_memory", "Delete a personal memory only when the current user explicitly asks to forget it.", "{id:string}", z.object({ id: z.string().min(1).max(100) }).strict(), async input => {
    if (!context.memoryStore || !/\b(?:forget|delete|remove)\b/i.test(latestMessage)) throw new Error("Forgetting memory requires the user's explicit request.");
    return { deleted: await context.memoryStore.forget(String(input.id)) };
  });
  add("propose_action", "Prepare one typed trade proposal for external permission checks. This tool never signs or executes.", "{request:TradeRequest}", z.object({ request: tradeRequestSchema }).strict(), async input => {
    const request = tradeRequestSchema.parse(input.request);
    const account = accountById(request.accountId);
    if (request.venue !== account.venue || context.account && account.id !== context.account.id) throw new Error("The proposed action does not match the selected trading account.");
    if (["close", "reduce", "stop-loss", "take-profit"].includes(request.type)) {
      const portfolio = account.venue === "uniswap" ? await getUniswapPortfolio(account) : await getHyperliquidPortfolio(account);
      const symbol = request.symbol.replace(/(?:[-/]?(?:USD|USDC))$/i, "");
      if (!portfolio.positions.some(position => position.symbol === symbol)) throw new Error("The selected account has no matching perpetual position. Spot holdings require a swap, not a close.");
      const mentioned = portfolio.positions.filter(position => {
        const escaped = position.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^a-z0-9_.])${escaped}($|[^a-z0-9_.])`, "i").test(latestMessage);
      });
      if (portfolio.positions.length > 1 && (mentioned.length !== 1 || mentioned[0].symbol !== symbol)) throw new Error("Several positions are open. Ask which position the user means before proposing a change.");
    }
    return { proposal: { ...request, mode: "agent" }, executable: false, authorization: "Pending independent account permissions and execution checks." };
  });
  add("propose_automation", "Propose a bounded scheduled trade/DCA or price alert for explicit user acceptance. Does not create, activate or execute an automation.", "{automation:{kind:'trade'|'alert',accountId,name,intervalSeconds:60..86400,expiresAt?:epochMs,instruction?:string,request?:TradeRequest,condition?:{symbol,operator:'above'|'below',price:positiveDecimalString}}}. Trade requires request. Alert requires condition and forbids request.", z.object({ automation: automationProposalSchema }).strict(), async input => {
    const automation = automationProposalSchema.parse(input.automation);
    const account = accountById(automation.accountId);
    if (context.account && context.account.id !== account.id) throw new Error("The automation does not match the selected trading account.");
    const now = Date.now();
    if (automation.expiresAt !== undefined && (automation.expiresAt <= now || automation.expiresAt > now + 30 * 86_400_000)) throw new Error("Automation expiry must be in the future and no more than 30 days away.");
    if (automation.kind === "trade" && (automation.request.accountId !== account.id || automation.request.venue !== account.venue)) throw new Error("The scheduled trade does not belong to this automation's connected account.");
    const automationProposal = automation.kind === "trade"
      ? { ...automation, request: { ...automation.request, mode: "agent" }, instruction: automation.instruction ?? latestMessage.slice(0, 2000) }
      : { ...automation, expiresAt: automation.expiresAt ?? now + 86_400_000 };
    return { automationProposal, executable: false, created: false, authorization: "User acceptance is required. The server independently checks expiry, budgets, account grants and CRE policy before any scheduled trade." };
  });
  return selectProfileTools(registry, profile);
}
