export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    cache: "no-store",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.error) throw new ApiError(result?.error?.code ?? "REQUEST_FAILED", result?.error?.message ?? `Request failed (${response.status}). Please try again.`, response.status);
  return (result && Object.hasOwn(result, "data") ? result.data : result) as T;
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

const safeErrors: Record<string, string> = {
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
  PRICE_REQUIRED: "Enter a positive limit price before reviewing this order.",
  TRIGGER_REQUIRED: "Enter a positive trigger price before reviewing this order.",
  INSUFFICIENT_FUNDS: "The account paying this transfer lacks the amount or network fee. Check its balance before retrying.",
  INSUFFICIENT_GAS: "Your owner wallet needs Sepolia ETH for the deposit network fee. Trading gas sponsorship does not cover external-wallet deposits.",
  FUNDING_RECOVERY_UNAVAILABLE: "Browser recovery storage is unavailable, so no deposit was started. Enable storage for this site before trying again.",
  INSUFFICIENT_BALANCE: "Fund the selected trading account with the input asset before trading.",
  INSUFFICIENT_TOKEN_BALANCE: "Fund the selected trading account with the input asset before trading.",
  INSUFFICIENT_NATIVE_BALANCE: "Your trading account needs native Sepolia ETH for this exact swap input. This is separate from sponsored gas.",
  NATIVE_INPUT_ACCOUNT_REQUIRED: "Create a smart trading account for atomic ETH input, or wrap ETH separately before a WETH swap.",
  NATIVE_INPUT_PAIR_UNSUPPORTED: "Native ETH input is supported only for the WETH/USDC sell route on Sepolia.",
  NATIVE_WRAP_NOT_AUTHORIZED: "The owner must explicitly approve a bounded native ETH wrapping grant before the agent uses ETH input.",
  PREFLIGHT_FAILED: "Preflight could not verify the action. Refresh balances, quote, and gas sponsorship before retrying.",
  VENUE_PREFLIGHT_FAILED: "The venue could not validate this order. Refresh its balances and market data before retrying.",
  SIGNING_FAILED: "Your wallet could not sign this action. Nothing new was submitted.",
  SUBMISSION_UNKNOWN: "Submission is uncertain. Check the same action in activity; do not submit a replacement.",
  SWAP_REVERTED: "The swap reverted onchain. Review its receipt in activity before preparing another.",
  VENUE_REJECTED: "The venue rejected this order. Review balances, order size, and open orders before trying again.",
  PENDING_APPROVAL_INVALIDATION_REQUIRED: "An older signed session approval is still usable. Pause the agent, then invalidate that approval before granting new access.",
  BUNDLER_UNCONFIGURED: "The testnet bundler is not configured. You can inspect accounts, but smart-account execution is unavailable.",
  PAYMASTER_UNCONFIGURED: "Gas sponsorship is not configured. This action is disabled; owner-paid gas will not be used instead.",
  SPONSORSHIP_UNCONFIGURED: "Gas sponsorship is not configured. This action is disabled; owner-paid gas will not be used instead.",
  SPONSORSHIP_REJECTED: "Gas sponsorship was declined. No owner-paid fallback was attempted. Review the sponsor limits before retrying.",
  SPONSORSHIP_UNAVAILABLE: "The platform gas sponsor could not approve this request. Refresh readiness; no owner-paid fallback was attempted.",
  SPONSORSHIP_USER_CAP: "Your platform gas allowance is exhausted or reserved. Reconcile existing activity or wait for its reset; owner-paid gas will not be used instead.",
  SPONSORSHIP_PROJECT_CAP: "The shared platform gas allowance is exhausted or reserved. Check existing activity or try later; owner-paid gas will not be used instead.",
  SPONSORSHIP_CONFIG_INVALID: "Platform gas coverage is temporarily unavailable. Wait for readiness to recover; no owner-paid fallback was attempted.",
  SPONSORSHIP_ALREADY_SUBMITTED: "This operation was already submitted or finalized. Check its existing activity record; do not send a replacement.",
  SPONSORSHIP_RECEIPT_PENDING: "The operation receipt is not available yet and its gas allowance remains reserved. Reconcile the existing operation; do not submit it again.",
  SPONSORSHIP_ACTION_STALE: "The sponsored action expired or changed. Refresh the account and prepare a new quote.",
  SPONSORSHIP_CALL_MISMATCH: "The requested account calls do not match the approved action. Nothing new was authorized; prepare a fresh quote.",
  SPONSORSHIP_ACCOUNT_MISMATCH: "Gas sponsorship is not approved for this trading account. Refresh and select the correct owner account.",
  SPONSORSHIP_GRANT_MISMATCH: "The sponsored operation does not match the account's current agent grant. Refresh permissions before trying again.",
  SPONSORSHIP_AUTHORITY_CHANGED: "Agent authority changed before gas approval. Refresh account permissions before preparing a new action.",
  SPONSORSHIP_SCOPE_REQUIRED: "Gas coverage requires a reviewed trade or an explicit account-permission recovery action.",
  SPONSORSHIP_OWNER_MISMATCH: "The trading account does not match the signed-in owner. Reconnect its owner and refresh.",
  SPONSORSHIP_FACTORY_MISMATCH: "The trading account deployment could not be verified. Refresh its setup before requesting gas coverage.",
  SPONSORSHIP_ENTRYPOINT_MISMATCH: "This smart-account operation is not supported on the configured testnet. Refresh its account setup.",
  SPONSORSHIP_SIGNATURE_REQUIRED: "Review and sign the exact sponsored operation in your owner wallet before submitting it.",
  SPONSORSHIP_HASH_INVALID: "The signed operation identity could not be verified. Check existing activity before trying another action.",
  SPONSORSHIP_REQUIRED: "This action requires gas sponsorship. Refresh sponsor readiness before signing.",
  AUTH_REQUIRED: "Your session expired. Sign in with your owner wallet again.",
  AGENT_NOT_APPROVED: "Approve a scoped agent permission for this trading account first.",
  AGENT_NOT_AUTHORIZED: "The agent has no valid permission for this action. Review its account grant.",
  INSUFFICIENT_BUDGET: "The agent expense allowance is exhausted. Review its separate operating budget.",
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
  if (nodes.some(node => typeof node.code === "string" && node.code.startsWith("SPONSORSHIP_"))) return "Trading gas approval could not be verified. Check existing activity and platform readiness; no owner-paid fallback was attempted.";
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
