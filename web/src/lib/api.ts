import { demoResponse } from "./demo-api";
import { DEMO_READ_ONLY_MESSAGE, demoReadOnlyError, hasDemoTarget, isDemoMode } from "./demo-mode";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const demo = isDemoMode();
  if (demo) {
    const result = demoResponse(path, options.method);
    if (result.handled) return result.data as T;
  } else if (hasDemoTarget(path, options.body)) throw demoReadOnlyError();
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    cache: "no-store",
  });
  const result = await response.json().catch(() => null);
  if (isDemoMode() !== demo) throw new ApiError("ACCOUNT_CHANGED", "Account mode changed while loading.", 409);
  if (!response.ok || result?.error) throw new ApiError(result?.error?.code ?? "REQUEST_FAILED", result?.error?.message ?? `Request failed (${response.status}). Please try again.`, response.status);
  return (result && Object.hasOwn(result, "data") ? result.data : result) as T;
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

const safeErrors: Record<string, string> = {
  DEMO_READ_ONLY: DEMO_READ_ONLY_MESSAGE,
  DEMO_WALLET_BUSY: "Finish or dismiss the current wallet request before changing accounts.",
  OSTIUM_ALLOWANCE_REQUIRED: "Approve the exact USDC allowance in account settings, wait for its receipt, then review this action again.",
  OSTIUM_AUTOMATION_PENDING: "Native Ostium conditional strategies are not ready yet. Manual trading remains separate.",
  OSTIUM_DELEGATE_EXISTS: "Another native delegate is active. Review it in your owner wallet; Orcus will not silently replace it.",
  OSTIUM_AUTHORITY_UNVERIFIED: "Native agent authority could not be verified. Refresh; new agent access stays disabled.",
  OSTIUM_DAY_TRADE_REQUIRED: "Review this pair's day-trade and overnight leverage limits before opening.",
  OSTIUM_MARKET_DISABLED: "This market is not accepting new positions. Select another market or review an existing position.",
  OSTIUM_TRADE_LIMIT: "Collateral or leverage is outside this pair's current venue limits. Review the inputs and pair details.",
  OSTIUM_COLLATERAL_LIMIT: "This collateral change exceeds the venue's current safe limit. Refresh the position before reviewing again.",
  OSTIUM_STALE_PRICES: "A fresh native price is unavailable. Refresh the selected pair before reviewing a trade.",
  OSTIUM_PREVIEW_REJECTED: "The venue could not approve this order's current fees, exposure or limits. Review the inputs and refresh.",
  ALLOWANCE_PENDING: "An existing allowance is still resolving. Recover its recorded transaction before starting another wallet request.",
  ALLOWANCE_HASH_REQUIRED: "Find the existing approval transaction hash in your owner wallet. No approval is repeated automatically.",
  ALLOWANCE_EXPIRED: "This unsigned allowance review expired. Cancel it explicitly and prepare a new exact amount.",
  ALLOWANCE_UNVERIFIED: "The existing allowance receipt could not be verified. Keep its record and check again; do not repeat it.",
  ALLOWANCE_CLAIM_MISMATCH: "Another wallet attempt owns this approval request. Check the existing request before retrying.",
  OWNER_SIGNATURE_REQUIRED: "This action requires your owner wallet. It cannot be executed by the agent.",
  OWNER_ONLY: "This action requires your owner wallet. It cannot be executed by the agent.",
  OWNER_REJECTED: "Cancelled in your wallet. Nothing new was submitted.",
  OWNER_CHANGED: "Your owner wallet changed. Reconnect the account owner before signing.",
  ACCOUNT_CHANGED: "Your session or trading account changed. Refresh before signing.",
  ACCOUNT_MISMATCH: "This action does not match your trading account. Refresh and choose the correct account.",
  ACCOUNT_RECONCILING: "This account has an unresolved submission. Check activity before preparing another action.",
  ACTION_RECONCILIATION_REQUIRED: "Check the existing action in activity before submitting another.",
  ACCOUNT_BUSY: "Another action is in progress for this account. Wait for its result.",
  OWNER_TYPE_UNSUPPORTED: "This setup currently needs an EOA owner wallet. Contract-wallet owners are not supported yet.",
  NETWORK_CHANGED: "Switch your wallet to the requested testnet, then review the action again.",
  WRONG_NETWORK: "Use the supported venue testnet. Cross-chain trading is not configured.",
  QUOTE_EXPIRED: "This quote expired. Prepare a fresh quote before signing.",
  STALE_ACTION: "This action is stale. Refresh the account and prepare a fresh quote.",
  INVALID_AMOUNT: "Enter a positive amount with the supported token precision.",
  INVALID_PRECISION: "The amount has too many decimal places for this asset.",
  MINIMUM_NOTIONAL: "Hyperliquid requires at least 10 USDC of order value. Increase the amount and review again.",
  MARKET_DATA_UNAVAILABLE: "A current market price is unavailable. Refresh market data before reviewing this order.",
  UNSUPPORTED_MARKET: "Choose a supported market before preparing this trade.",
  TOKEN_DIRECTION_MISMATCH: "Review the buy/sell direction and selected tokens before preparing this swap.",
  TRADE_LIMIT: "This trade exceeds the agent's approved limit; reduce its size or review permissions as the owner.",
  PRICE_REQUIRED: "Enter a positive limit price before reviewing this order.",
  TRIGGER_REQUIRED: "Enter a positive trigger price before reviewing this order.",
  INSUFFICIENT_FUNDS: "The account paying this transfer lacks the amount or network fee. Check its balance before retrying.",
  INSUFFICIENT_GAS: "The account paying this action needs ETH on the action's network. For external-wallet deposits, fund the owner wallet; for Uniswap trades, fund the trading smart account on Sepolia.",
  FUNDING_RECOVERY_UNAVAILABLE: "Browser recovery storage is unavailable, so no deposit was started. Enable storage for this site before trying again.",
  INSUFFICIENT_BALANCE: "Fund the selected trading account with the input asset before trading.",
  INSUFFICIENT_TOKEN_BALANCE: "Fund the selected trading account with the input asset before trading.",
  INSUFFICIENT_NATIVE_BALANCE: "Your trading account needs native Sepolia ETH for the swap input plus enough ETH left for gas. Fund its Sepolia address in Accounts.",
  NATIVE_INPUT_ACCOUNT_REQUIRED: "Create a smart trading account for atomic ETH input, or wrap ETH separately before a WETH swap.",
  NATIVE_INPUT_PAIR_UNSUPPORTED: "Native ETH input is supported only for the WETH/USDC sell route on Sepolia.",
  NATIVE_WRAP_NOT_AUTHORIZED: "The owner must explicitly approve a bounded native ETH wrapping grant before the agent uses ETH input.",
  PREFLIGHT_FAILED: "Wallet checks failed before sending. Check your connection and try again.",
  GAS_ESTIMATION_FAILED: "Gas estimation failed before submission. Check your Arbitrum Sepolia connection and balance, then try again.",
  VENUE_PREFLIGHT_FAILED: "The venue could not validate this order. Refresh its balances and market data before retrying.",
  SIGNING_FAILED: "Your wallet could not sign this action. Nothing new was submitted.",
  SUBMISSION_UNKNOWN: "Submission is uncertain. Check the same action in activity; do not submit a replacement.",
  SWAP_REVERTED: "The swap reverted onchain. Review its receipt in activity before preparing another.",
  VENUE_REJECTED: "The venue rejected this order. Review balances, order size, and open orders before trying again.",
  PENDING_APPROVAL_INVALIDATION_REQUIRED: "An older signed session approval is still usable. Pause the agent, then invalidate that approval before granting new access.",
  BUNDLER_UNCONFIGURED: "The testnet bundler is not configured. You can inspect accounts, but smart-account execution is unavailable.",
  SMART_ACCOUNT_GAS_INSUFFICIENT: "Your trading smart account needs Sepolia ETH for gas. Open Accounts and fund its trading address, not the agent signer. Keep ETH for gas beyond any swap input.",
  GAS_LIMIT_EXCEEDED: "The estimated network fee exceeds the operation cap. Nothing was submitted. Wait for lower fees before preparing a new action.",
  INVALID_GAS_ESTIMATE: "The network fee estimate could not be verified. Nothing new was signed. Refresh the action before trying again.",
  GAS_BALANCE_UNAVAILABLE: "The trading account's Sepolia ETH balance could not be checked. Refresh balances before signing; no automatic top-up was attempted.",
  USER_OPERATION_ALREADY_RECORDED: "This operation is already recorded. Check the same operation in activity; do not submit a replacement.",
  SPONSORSHIP_ALREADY_SUBMITTED: "This legacy operation was already submitted or finalized. Check its existing activity record; do not send a replacement.",
  SPONSORSHIP_RECEIPT_PENDING: "This legacy operation is still awaiting a receipt. Reconcile its existing activity record; do not submit it again.",
  PAYMASTER_UNCONFIGURED: "This legacy gas operation is no longer supported. Check activity, then refresh before preparing a self-funded action.",
  AUTH_REQUIRED: "Your session expired. Sign in with your owner wallet again.",
  AGENT_NOT_APPROVED: "Approve a scoped agent permission for this trading account first.",
  AGENT_NOT_AUTHORIZED: "The agent has no valid permission for this action. Review its account grant.",
  AGENT_PAUSED: "The agent is paused. Owner controls remain available; resume only when you want new agent actions.",
  AUTOMATION_UNAVAILABLE: "This strategy cannot resume while its agent is paused or its grant is expired. Review permissions and create a renewed strategy if needed.",
  CONTROL_CHANGED: "Account authority changed before signing. Refresh permissions and review the action again.",
  STRATEGY_CHANGED: "This strategy or its account authority changed during evaluation. Review its current status before resuming.",
  INSUFFICIENT_BUDGET: "Your remaining spending limit cannot cover this request. Review the limit and pending expenses in Settings; this is separate from your 0G credits.",
  INSUFFICIENT_SERVICE_CREDITS: "Your verified testnet service credits are too low. Add credits or reconcile a pending payment; increasing the expense cap does not add credits.",
  OPERATOR_COMPUTE_USER_CAP: "Your daily platform compute allowance is exhausted or reserved by pending requests. Increasing your expense cap cannot raise this platform limit.",
  OPERATOR_COMPUTE_PROJECT_CAP: "The shared daily platform compute allowance is exhausted or reserved. Reconcile pending requests or wait for the operator's allowance to reset.",
  COMPUTE_CAP_CONFIG_INVALID: "The platform compute allowance is temporarily unavailable. No new inference was requested.",
  BUDGET_RESERVED: "This cap cannot be below recorded or reserved expenses. Reconcile pending requests first.",
  OPERATING_BALANCE_LOW: "The separate operating wallet needs testnet 0G. Trading principal will not be used.",
  COMPUTE_ACCOUNT_UNVERIFIED: "A fresh native Galileo Router balance for the exact beneficiary is required. Inference-only keys, USD billing, and mainnet accounts cannot fund this path.",
  COMPUTE_VAULT_UNVERIFIED: "The PaymentVault balance could not be verified. Refresh before preparing a compute deposit.",
  COMPUTE_FUNDING_CAP: "The native compute-funding cap cannot cover this deposit and its fee. Review the remaining cap.",
  COMPUTE_FUNDING_DISABLED: "Compute replenishment is disabled or expired. Authorize an exact capped policy to enable it.",
  FUNDING_SUBMISSION_UNCERTAIN: "Reconcile this same funding transaction before releasing its reservation or sending another deposit.",
  PRIVATE_INFERENCE_UNVERIFIED: "Private inference evidence could not be verified. No public-inference fallback is allowed under this policy.",
  INFERENCE_OUTCOME_UNKNOWN: "The inference result is uncertain. Reconcile its usage before repeating a potentially billable request.",
  MEMORY_SECRET_REJECTED: "Do not save credentials or private keys in agent memory.",
  CREDENTIAL_INPUT_REJECTED: "Remove credentials or private keys from the message before continuing.",
  RPC_UNAVAILABLE: "The network service is unavailable. Refresh before trying again.",
};

export function displayError(error: unknown): string {
  const nodes: Array<{ code?: unknown; message?: string; phase?: unknown; status?: unknown }> = [];
  const seen = new Set<unknown>();
  try {
    let current = error;
    while (current && typeof current === "object" && nodes.length < 6 && !seen.has(current)) {
      seen.add(current);
      const value = current as { code?: unknown; message?: unknown; cause?: unknown; phase?: unknown; status?: unknown };
      nodes.push({ code: value.code, message: typeof value.message === "string" ? value.message.slice(0, 2000) : undefined, phase: value.phase, status: value.status });
      current = value.cause;
    }
  } catch { return "The action could not be completed. Refresh and try again."; }
  if (nodes.some(node => node.phase === "submitted-unknown" || node.code === "SUBMISSION_UNKNOWN")) return safeErrors.SUBMISSION_UNKNOWN!;
  if (nodes.some(node => node.code === 4001 || node.code === "ACTION_REJECTED" || node.code === "OWNER_REJECTED" || /user rejected|user denied/i.test(node.message ?? ""))) return "Cancelled in your wallet. Nothing new was submitted.";
  for (const node of nodes) if (typeof node.code === "string" && Object.hasOwn(safeErrors, node.code)) return safeErrors[node.code]!;
  if (nodes.some(node => typeof node.code === "string" && node.code.startsWith("SPONSORSHIP_"))) return "This legacy gas operation is no longer supported. Check existing activity, then refresh the app before preparing a new self-funded action.";
  if (nodes.some(node => node.status === 401 || node.code === 4100)) return safeErrors.AUTH_REQUIRED!;
  if (nodes.some(node => node.code === -32002)) return "A wallet request is already open. Confirm or dismiss it in your wallet.";
  if (nodes.some(node => node.code === 4902 || node.code === 4901)) return safeErrors.NETWORK_CHANGED!;
  const messages = nodes.map(node => node.message ?? "").join(" ");
  if (/quote.*expired|expired.*quote/i.test(messages)) return safeErrors.QUOTE_EXPIRED!;
  if (/wallet.*changed|reconnect.*owner/i.test(messages)) return safeErrors.OWNER_CHANGED!;
  if (/install.*wallet|wallet extension/i.test(messages)) return "Install or open a browser wallet, then connect your owner account.";
  if (/insufficient funds|insufficient balance/i.test(messages)) return safeErrors.INSUFFICIENT_FUNDS!;
  if (/execution reverted/i.test(messages)) return "The transaction reverted. Check its receipt in activity before preparing another.";
  if (/fetch|network|ECONNREFUSED|timed? ?out|timeout/i.test(messages)) return "Connection unavailable. Check activity for any pending submission before retrying.";
  return "The action could not be completed. Refresh and try again.";
}
