import type { HealthStatus, PreparedAction, TradingAccount, TradeRequest, Venue } from "@orcus/core";
import { engineConfig } from "./config";
import { EngineError } from "./errors";
import { getHyperliquidBook, getHyperliquidCandles, getHyperliquidMarkets, getHyperliquidPortfolio, prepareHyperliquidAction, reconcileHyperliquidAction, submitHyperliquidAgentAction } from "./venues/hyperliquid";
import { getUniswapMarkets, getUniswapPortfolio, prepareUniswapAction, reconcileUniswapAction } from "./venues/uniswap";

export { planWith0G, getComputeBalance } from "./compute";
export { uploadMemory, downloadMemory, encryptMemory, decryptMemory } from "./storage";
export { evaluateStrategy, parseCreOutput } from "./automation/cre";
export { engineConfig } from "./config";
export { EngineError } from "./errors";
export type { AccountPortfolio, SubmissionResult, PlannerContext } from "./types";

export function getHealth(): HealthStatus {
  const cfg = engineConfig();
  const compute = Boolean(cfg.compute.url && cfg.compute.apiKey && cfg.compute.model);
  return {
    mode: "testnet",
    compute: { configured: compute, ready: compute, message: compute ? "0G endpoint configured. Request evidence is captured per inference; TEE attestation is not yet verified." : "Configure ZEROG_COMPUTE_CHAT_URL, ZEROG_COMPUTE_API_KEY and ZEROG_COMPUTE_MODEL." },
    storage: { configured: cfg.storage.configured, ready: cfg.storage.configured, message: cfg.storage.configured ? "Encrypted 0G Storage enabled; uploads require an authorized funded Galileo signer." : "Enable ZEROG_STORAGE_ENABLED after funding an isolated Galileo operating wallet." },
    uniswap: { configured: true, ready: true, message: "Sepolia Uniswap V3. Real liquidity and token allowance are checked during quotes." },
    hyperliquid: { configured: true, ready: true, message: "Hyperliquid testnet public reads enabled. Trading needs explicit owner/agent authorization." },
    cre: { configured: cfg.cre.enabled, ready: cfg.cre.enabled && Boolean(cfg.cre.workflowDir), message: cfg.cre.enabled ? "CRE local simulation configured; CLI login, workflow compilation and output are checked per evaluation." : "Configure CRE_ENABLED, CRE_CLI_PATH and CRE_WORKFLOW_DIR, then authenticate the CRE CLI." },
  };
}

export function getMarkets(venue: Venue = "hyperliquid") { return venue === "uniswap" ? getUniswapMarkets() : getHyperliquidMarkets(); }
export function getPortfolio(account: TradingAccount) { return account.venue === "uniswap" ? getUniswapPortfolio(account) : getHyperliquidPortfolio(account); }
export function getCandles(input: { venue?: Venue; symbol: string; interval?: string; limit?: number }) {
  if (input.venue === "uniswap") throw new EngineError("CANDLES_UNAVAILABLE", "Historical candle data is not configured for this Sepolia spot pool. The live swap quote remains available.", 503);
  return getHyperliquidCandles(input);
}
export function getOrderBook(symbol: string) { return getHyperliquidBook(symbol); }
export function prepareAction(action: TradeRequest, account: TradingAccount) { return action.venue === "uniswap" ? prepareUniswapAction(action, account) : prepareHyperliquidAction(action, account); }

export async function submitAgentAction(prepared: PreparedAction, account: TradingAccount, privateKey: string, options?: { authorization?: unknown }) {
  if (account.status !== "authorized" || prepared.account.id !== account.id || prepared.controlRevision !== account.controlRevision || prepared.expiresAt <= Date.now()) throw new EngineError("AUTHORIZATION_REQUIRED", "Current authorization and a fresh action are required before agent signing.");
  if (account.venue === "hyperliquid") return submitHyperliquidAgentAction(prepared, account, privateKey);
  if (!account.smartAccountAddress || !options?.authorization) throw new EngineError("SESSION_REQUIRED", "Agent spot execution requires an explicit bounded smart-account session grant.");
  const moduleName = "@orcus/wallets/server";
  const { submitKernelSessionAction } = await import(moduleName);
  return submitKernelSessionAction(prepared, privateKey, options.authorization);
}

export function reconcileAction(action: { transactionHash?: string; txHash?: string; orderId?: string; id?: string; prepared?: PreparedAction }, account: TradingAccount) {
  return account.venue === "uniswap" ? reconcileUniswapAction(action, account) : reconcileHyperliquidAction(action, account);
}
