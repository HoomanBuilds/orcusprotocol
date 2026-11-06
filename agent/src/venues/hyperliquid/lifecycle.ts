/* Adapted from Hummingbot's order states and fill tracking under Apache-2.0.
 * TypeScript and exact-decimal modifications: see licenses/hummingbot-NOTICE.md.
 */
import type { SubmissionResult } from "../../types";
import { atomsToDecimal, decimalToAtoms } from "./wire-format";

const venueStates = new Map<string, SubmissionResult["status"]>([
  ["open", "pending"], ["resting", "pending"], ["triggered", "pending"],
  ["filled", "confirmed"], ["canceled", "cancelled"], ["rejected", "rejected"],
  ...["marginCanceled", "vaultWithdrawalCanceled", "openInterestCapCanceled", "selfTradeCanceled", "reduceOnlyCanceled", "siblingFilledCanceled", "delistedCanceled", "liquidatedCanceled", "outcomeSettledCanceled", "scheduledCancel", "internalCancel"].map(status => [status, "cancelled"] as const),
  ...["tickRejected", "minTradeNtlRejected", "perpMarginRejected", "reduceOnlyRejected", "badAloPxRejected", "iocCancelRejected", "badTriggerPxRejected", "marketOrderNoLiquidityRejected", "positionIncreaseAtOpenInterestCapRejected", "positionFlipAtOpenInterestCapRejected", "tooAggressiveAtOpenInterestCapRejected", "openInterestIncreaseRejected", "insufficientSpotBalanceRejected", "oracleRejected", "perpMaxPositionRejected", "tooManyOpenOrdersRejected"].map(status => [status, "rejected"] as const),
]);

export function classifyOrderStatus(status: string): SubmissionResult["status"] {
  return venueStates.get(status) ?? "submitted-unknown";
}

export function sizeProgress(remaining: unknown, original: unknown) {
  if (typeof remaining !== "string" || typeof original !== "string") return undefined;
  try {
    const open = decimalToAtoms(remaining, 36), total = decimalToAtoms(original, 36);
    if (total <= 0n || open > total) return undefined;
    return { partial: open > 0n && open < total, remainingSize: atomsToDecimal(open, 36), originalSize: atomsToDecimal(total, 36) };
  } catch { return undefined; }
}

interface ObservedFill { tradeId: string; size: string; price: string; fee: string; feeToken: string; timestamp: number; transactionHash?: string }

export function summarizeOrderFills(raw: unknown, orderId: number, symbol?: string, originalSize?: string) {
  if (!Array.isArray(raw) || raw.length > 2000) throw new Error("The venue returned an unsupported fill history response.");
  const fills: ObservedFill[] = [], seen = new Set<string>(), fees = new Map<string, bigint>();
  let base = 0n, quote = 0n, invalid = false;
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object" || candidate.oid !== orderId) continue;
    if (symbol && candidate.coin !== symbol) continue;
    const tradeId = typeof candidate.tid === "string" && /^\d{1,80}$/.test(candidate.tid) ? candidate.tid : Number.isSafeInteger(candidate.tid) && candidate.tid >= 0 ? String(candidate.tid) : undefined;
    if (!tradeId || seen.has(tradeId)) { if (!tradeId) invalid = true; continue; }
    try {
      if (typeof candidate.sz !== "string" || typeof candidate.px !== "string" || typeof candidate.fee !== "string" || typeof candidate.feeToken !== "string" || !/^[A-Za-z0-9._:-]{1,40}$/.test(candidate.feeToken) || !Number.isSafeInteger(candidate.time) || candidate.time <= 0) throw new Error("Invalid fill evidence.");
      const size = decimalToAtoms(candidate.sz, 36), price = decimalToAtoms(candidate.px, 36);
      if (size <= 0n || price <= 0n) throw new Error("Invalid fill amount.");
      const negativeFee = candidate.fee.startsWith("-");
      const fee = decimalToAtoms(negativeFee ? candidate.fee.slice(1) : candidate.fee, 36) * (negativeFee ? -1n : 1n);
      seen.add(tradeId);
      base += size;
      quote += size * price;
      fees.set(candidate.feeToken, (fees.get(candidate.feeToken) ?? 0n) + fee);
      fills.push({ tradeId, size: atomsToDecimal(size, 36), price: atomsToDecimal(price, 36), fee: candidate.fee, feeToken: candidate.feeToken, timestamp: candidate.time, ...(typeof candidate.hash === "string" && /^0x[\da-fA-F]{64}$/.test(candidate.hash) ? { transactionHash: candidate.hash } : {}) });
    } catch { invalid = true; }
  }
  let fillsComplete = false;
  if (originalSize && raw.length < 2000 && !invalid) {
    try { fillsComplete = base > 0n && base === decimalToAtoms(originalSize, 36); } catch {}
  }
  return {
    fills, observedExecutedSize: atomsToDecimal(base, 36), observedExecutedQuote: atomsToDecimal(quote, 72),
    observedFeesByToken: Object.fromEntries([...fees].map(([token, amount]) => [token, `${amount < 0n ? "-" : ""}${atomsToDecimal(amount < 0n ? -amount : amount, 36)}`])),
    fillEvidenceStatus: raw.length === 2000 ? "truncated" : invalid ? "invalid-rows" : "observed", fillsComplete,
  };
}
