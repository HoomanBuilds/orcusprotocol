import type { ActionStatus, PreparedAction, TradeRequest, Venue } from "@orcus/core";
import { parseUnits } from "viem";

export interface WalletExecutionConfig {
  chainId: number;
  smartAccountsConfigured: boolean;
  gasPayment?: { mode: "self-funded"; payer: "smart-account"; maxOperationGasWei: string; chainId: number };
}

export function tradingGasStatus(config: WalletExecutionConfig | null, venue: Venue) {
  if (venue === "ostium") return { ready: true, label: "Arbitrum Sepolia gas paid by signer", detail: "Owner actions use the owner's Arbitrum Sepolia ETH. Authorized agent actions use that account's agent signer ETH. USDC collateral and oracle fees are separate. No automatic gas top-ups." };
  if (venue === "hyperliquid") return { ready: true, label: "Venue trading fees apply", detail: "Hyperliquid testnet orders use signed API requests for your existing venue account, with separate venue trading fees rather than Ethereum transaction gas." };
  const ready = config?.chainId === 11155111 && config.smartAccountsConfigured && config.gasPayment?.mode === "self-funded" && config.gasPayment.payer === "smart-account" && config.gasPayment.chainId === 11155111;
  return ready
    ? { ready: true, label: "Trading account pays Sepolia ETH", detail: "Fund your trading smart account with Sepolia ETH for gas as well as the assets you trade. Manual and agent actions spend gas from that same account, not the session signer. Gas is checked before signing; no automatic top-ups." }
    : { ready: false, label: "Smart-account execution unavailable", detail: "The Sepolia execution service is not ready. You can still inspect your account. A configured service does not prove the account has enough ETH for gas." };
}

export function actionRecovery(status: ActionStatus): string | undefined {
  if (["submitting", "submitted-unknown"].includes(status)) return "Submission is not resolved. Check this same action; do not send a replacement.";
  if (status === "pending") return "Submitted, not confirmed. Check status before placing the same action again.";
  if (status === "partially-filled") return "Only part of this order filled. Check the remaining venue order before changing exposure.";
  if (status === "rejected") return "The action was rejected. Review account balances, order limits, and ETH available for gas before a new quote.";
  if (status === "cancelled") return "Cancelled. Check the venue for any fills that happened before cancellation.";
  return undefined;
}

export function actionReviewLabel(request: Pick<TradeRequest, "type" | "side">): string {
  switch (request.type) {
    case "cancel": return "Cancel order";
    case "edit-order": return "Update order";
    case "close": return "Close position";
    case "reduce": return "Reduce position";
    case "stop-loss": return "Update stop-loss";
    case "take-profit": return "Update take-profit";
    case "add-collateral": return "Add collateral";
    case "remove-collateral": return "Remove collateral";
    default: return request.side === "buy" ? "Buy" : "Sell";
  }
}

export function fundingRecovery(value: unknown): { status: "confirmed" | "unknown" | "reverted"; transactionHash?: string } | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.status !== "string" || !["confirmed", "unknown", "reverted"].includes(input.status)) return null;
  const transactionHash = typeof input.transactionHash === "string" && /^0x[a-f\d]{64}$/i.test(input.transactionHash) ? input.transactionHash : undefined;
  if (input.status !== "unknown" && !transactionHash) return null;
  return { status: input.status as "confirmed" | "unknown" | "reverted", ...(transactionHash ? { transactionHash } : {}) };
}

export function withFundingRecoveryIntent<T>(storage: Pick<Storage, "getItem" | "setItem">, key: string, send: () => Promise<T>): Promise<T> {
  try {
    const intent = JSON.stringify({ status: "unknown" });
    storage.setItem(key, intent);
    if (storage.getItem(key) !== intent) throw new Error("Recovery record was not saved.");
  } catch {
    throw Object.assign(new Error("Funding recovery storage is unavailable."), { code: "FUNDING_RECOVERY_UNAVAILABLE", phase: "not-submitted" });
  }
  return send();
}

export function hasAtomicNativeInput(prepared: PreparedAction): boolean {
  if (!prepared.request.nativeInput) return false;
  try {
    const [wrap, ...remaining] = prepared.transactions ?? [];
    return prepared.request.venue === "uniswap" && prepared.request.side === "sell" && prepared.request.symbol === "WETH/USDC"
      && prepared.kind === "user-operation" && !!prepared.account.smartAccountAddress && prepared.account.smartAccountAddress.toLowerCase() === prepared.account.address.toLowerCase()
      && prepared.account.chainId === 11155111 && !!wrap && wrap.chainId === 11155111 && wrap.to.toLowerCase() === prepared.request.tokenIn?.toLowerCase()
      && wrap.data.toLowerCase() === "0xd0e30db0" && parseUnits(prepared.request.amount, 18) > 0n && BigInt(wrap.value) === parseUnits(prepared.request.amount, 18)
      && remaining.length > 0 && remaining.every(call => call.chainId === 11155111 && call.value === "0");
  } catch { return false; }
}
