import type { HealthStatus, PreparedAction, TradingAccount, TradeRequest, Venue } from "@orcus/core";
import { engineConfig } from "./config";
import { EngineError } from "./errors";
import { getHyperliquidBook, getHyperliquidCandles, getHyperliquidMarkets, getHyperliquidPortfolio, prepareHyperliquidAction, reconcileHyperliquidAction, submitHyperliquidAgentAction } from "./venues/hyperliquid";
import { getUniswapMarkets, getUniswapPortfolio, prepareUniswapAction, reconcileUniswapAction } from "./venues/uniswap";
import { getOstiumCandles, getOstiumMarkets, getOstiumPortfolio, prepareOstiumAction, reconcileOstiumAction, submitOstiumAgentAction } from "./venues/ostium";

export { planWith0G, getComputeBalance } from "./compute";
export { uploadMemory, downloadMemory, encryptMemory, decryptMemory, reconcileStorageExpense } from "./storage";
export { evaluateStrategy, parseCreOutput } from "./automation/cre";
export { engineConfig } from "./config";
export { getAgentModels, validateAgentModel, permittedAgentModel } from "./compute/models";
export { EngineError } from "./errors";
export { submitComputeFunding, reconcileComputeFunding, readComputeVaultBalance } from "./budget";
export type { AccountPortfolio, SubmissionResult, PlannerContext } from "./types";
export { getOstiumAuthorization, getOstiumApprovalTransaction, reconcileOstiumApproval, getOstiumDelegationTransactions, getOstiumHistory } from "./venues/ostium";

export function getHealth(): HealthStatus {
  const cfg = engineConfig();
  const compute = Boolean(cfg.compute.url && cfg.compute.apiKey && cfg.compute.model);
  return {
    mode: "testnet",
    compute: { configured: compute, ready: compute, message: compute ? "0G endpoint configured. Request evidence is captured per inference; TEE attestation is not yet verified." : "Configure ZEROG_COMPUTE_CHAT_URL, ZEROG_COMPUTE_API_KEY and ZEROG_COMPUTE_MODEL." },
    storage: { configured: cfg.storage.configured, ready: cfg.storage.configured, message: cfg.storage.configured ? "Encrypted 0G Storage enabled; the selected operator or agent payer needs funded Galileo gas. End users do not need 0G when the operator pays." : "0G Storage is disabled. Configure the operator's funded Galileo payer before enabling sponsored backups." },
    uniswap: { configured: true, ready: true, message: "Sepolia Uniswap V3. Real liquidity and token allowance are checked during quotes." },
    hyperliquid: { configured: true, ready: true, message: "Hyperliquid testnet public reads enabled. Trading needs explicit owner/agent authorization." },
    ostium: { configured: true, ready: true, message: "Ostium Arbitrum Sepolia reads and SDK builders configured. Trading verifies current markets, USDC, gas and native authority per action." },
    cre: { configured: cfg.cre.enabled, ready: cfg.cre.enabled && Boolean(cfg.cre.workflowDir), message: cfg.cre.enabled ? "CRE local simulation configured; CLI login, workflow compilation and output are checked per evaluation." : "Configure CRE_ENABLED, CRE_CLI_PATH and CRE_WORKFLOW_DIR, then authenticate the CRE CLI." },
  };
}

export function getMarkets(venue: Venue = "hyperliquid") {
  if (venue === "uniswap") return getUniswapMarkets();
  if (venue === "hyperliquid") return getHyperliquidMarkets();
  if (venue === "ostium") return getOstiumMarkets();
  throw new EngineError("UNSUPPORTED_VENUE", "Choose a supported testnet venue.");
}
export function getPortfolio(account: TradingAccount) {
  if (account.venue === "uniswap") return getUniswapPortfolio(account);
  if (account.venue === "hyperliquid") return getHyperliquidPortfolio(account);
  if (account.venue === "ostium") return getOstiumPortfolio(account);
  throw new EngineError("UNSUPPORTED_VENUE", "Choose a supported testnet venue.");
}
export function getCandles(input: { venue?: Venue; symbol: string; interval?: string; limit?: number }) {
  if (input.venue === "uniswap") throw new EngineError("CANDLES_UNAVAILABLE", "Historical candle data is not configured for this Sepolia spot pool. The live swap quote remains available.", 503);
  if (input.venue === "ostium") return getOstiumCandles(input);
  if (input.venue === undefined || input.venue === "hyperliquid") return getHyperliquidCandles(input);
  throw new EngineError("UNSUPPORTED_VENUE", "Choose a supported testnet venue.");
}
export function getOrderBook(symbol: string, venue: Venue = "hyperliquid") {
  if (venue !== "hyperliquid") throw new EngineError("ORDER_BOOK_UNAVAILABLE", "This venue does not provide a resting order book through this integration. Use its actual swap or trade preview.", 503);
  return getHyperliquidBook(symbol);
}
export function prepareAction(action: TradeRequest, account: TradingAccount) {
  if (action.venue === "uniswap") return prepareUniswapAction(action, account);
  if (action.venue === "hyperliquid") return prepareHyperliquidAction(action, account);
  if (action.venue === "ostium") return prepareOstiumAction(action, account);
  throw new EngineError("UNSUPPORTED_VENUE", "Choose a supported testnet venue.");
}

export async function submitAgentAction(prepared: PreparedAction, account: TradingAccount, privateKey: string, options?: { authorization?: unknown; assertAuthority?: (fresh?: PreparedAction) => void | Promise<void>; onSubmitted?: (evidence: { transactionHash: string; step?: "trade" }) => Promise<void> }) {
  if (account.status !== "authorized" || prepared.account.id !== account.id || prepared.controlRevision !== account.controlRevision || prepared.expiresAt <= Date.now()) throw new EngineError("AUTHORIZATION_REQUIRED", "Current authorization and a fresh action are required before agent signing.");
  if (account.venue === "hyperliquid") return submitHyperliquidAgentAction(prepared, account, privateKey, options);
  if (account.venue === "ostium") return submitOstiumAgentAction(prepared, account, privateKey, options);
  if (account.venue !== "uniswap") throw new EngineError("UNSUPPORTED_VENUE", "Choose a supported testnet venue.");
  if (!account.smartAccountAddress || !options?.authorization) throw new EngineError("SESSION_REQUIRED", "Agent spot execution requires an explicit bounded smart-account session grant.");
  const moduleName = "@orcus/wallets/server";
  const { submitKernelSessionAction } = await import(moduleName);
  return submitKernelSessionAction(prepared, privateKey, options.authorization, undefined, options.assertAuthority);
}

export function reconcileAction(action: { transactionHash?: string; txHash?: string; userOperationHash?: string; orderId?: string; id?: string; status?: string; createdAt?: number; prepared?: PreparedAction }, account: TradingAccount) {
  if (account.venue === "uniswap") return reconcileUniswapAction(action, account);
  if (account.venue === "hyperliquid") return reconcileHyperliquidAction(action, account);
  if (account.venue === "ostium") return reconcileOstiumAction(action, account);
  throw new EngineError("UNSUPPORTED_VENUE", "Choose a supported testnet venue.");
}
