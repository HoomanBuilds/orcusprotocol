import { getAddress } from "viem";
import type { PreparedAction } from "@orcus/core";
import { atomsToDecimal, decimalToAtoms } from "../../agent/src/venues/hyperliquid/wire-format";

export class VerificationSafetyError extends Error {}

export function verificationArgs(args: string[]) {
  const values = new Map<string, string>();
  let allowTrades = false;
  for (const argument of args) {
    if (argument === "--allow-testnet-trades" && !allowTrades) { allowTrades = true; continue; }
    const match = /^--(expected-owner|max-notional-usdc|max-fees-usdc)=(.+)$/.exec(argument);
    if (!match || values.has(match[1])) throw new VerificationSafetyError("Use only the documented, non-repeated testnet verification flags.");
    values.set(match[1], match[2]);
  }
  const owner = values.get("expected-owner");
  if (!owner) throw new VerificationSafetyError("Supply --expected-owner with the exact account to inspect.");
  const maxNotional = values.get("max-notional-usdc") ?? "20", maxFees = values.get("max-fees-usdc") ?? "1";
  if (decimalToAtoms(maxNotional, 6) > 20_000_000n || decimalToAtoms(maxNotional, 6) < 10_000_000n) throw new VerificationSafetyError("The one-position notional cap must be between 10 and 20 mock USDC.");
  if (decimalToAtoms(maxFees, 6) <= 0n || decimalToAtoms(maxFees, 6) > 1_000_000n) throw new VerificationSafetyError("The total fee cap must be positive and at most one mock USDC.");
  if (allowTrades && (!values.has("max-notional-usdc") || !values.has("max-fees-usdc"))) throw new VerificationSafetyError("Write mode requires explicit notional and fee caps.");
  return { owner: getAddress(owner), allowTrades, maxNotional, maxFees };
}

export function assertEmptyTestAccount(portfolio: { positions: unknown[]; orders: unknown[]; freeCollateralUsd?: string }, agents: Array<{ name: string }>) {
  if (portfolio.positions.length || portfolio.orders.length) throw new VerificationSafetyError("The test account already has positions or orders. No existing exposure will be changed.");
  if (!portfolio.freeCollateralUsd || decimalToAtoms(portfolio.freeCollateralUsd, 6) < 21_000_000n) throw new VerificationSafetyError("At least 21 mock USDC of free collateral is required for this bounded test.");
  if (agents.length >= 3) throw new VerificationSafetyError("No named-agent slot is available. Existing agents will not be replaced.");
}

export function cappedEthSize(midPrice: string, sizeDecimals: number, cap: string) {
  if (!Number.isInteger(sizeDecimals) || sizeDecimals < 0 || sizeDecimals > 6) throw new VerificationSafetyError("Unsupported ETH size precision.");
  const price = decimalToAtoms(midPrice, 18), notional = decimalToAtoms(cap, 18);
  if (price <= 0n) throw new VerificationSafetyError("A positive ETH price is required.");
  const atoms = notional * 10n ** BigInt(sizeDecimals) * 10_000n / (price * 10_050n);
  if (atoms <= 0n || atoms * price / 10n ** BigInt(sizeDecimals) < 10n ** 19n) throw new VerificationSafetyError("The bounded order would be below the venue's 10 mock USDC minimum.");
  return atomsToDecimal(atoms, sizeDecimals);
}

export function assertBoundedTestAction(prepared: PreparedAction, input: { owner: string; assetIndex: number; maxSize: string; maxNotional: string; opening: boolean }) {
  const operation = prepared.hyperliquid;
  if (prepared.kind !== "hyperliquid" || prepared.account.venue !== "hyperliquid" || prepared.account.chainId !== 421614 || getAddress(prepared.account.address) !== getAddress(input.owner) || prepared.request.symbol !== "ETH" || !operation || operation.method !== "order") throw new VerificationSafetyError("Only this owner's ETH testnet order is allowed.");
  const params = operation.params, orders = params.orders as Array<Record<string, unknown>> | undefined;
  if (params.vaultAddress || params.builder || params.grouping !== "na" || !orders || orders.length !== 1) throw new VerificationSafetyError("Vault, builder-fee and batched orders are outside this test.");
  const order = orders[0];
  if (order.a !== input.assetIndex || typeof order.s !== "string" || typeof order.p !== "string" || order.b !== input.opening || order.r !== !input.opening || decimalToAtoms(order.s, 18) > decimalToAtoms(input.maxSize, 18) || decimalToAtoms(order.s, 18) <= 0n) throw new VerificationSafetyError("The ETH order exceeded its size or reduction authority.");
  if (input.opening && (prepared.request.type !== "market" || decimalToAtoms(order.s, 18) * decimalToAtoms(order.p, 18) > decimalToAtoms(input.maxNotional, 18) * 10n ** 18n)) throw new VerificationSafetyError("The opening order exceeded the approved mock-USDC notional.");
  if (prepared.expiresAt <= Date.now()) throw new VerificationSafetyError("The prepared order expired before submission.");
}

export function positiveFees(fills: unknown, orderIds: Set<number>): string {
  if (!Array.isArray(fills) || fills.length >= 2000) throw new VerificationSafetyError("Complete fill evidence is required to check the fee cap.");
  let fees = 0n;
  const seen = new Set<string>();
  for (const fill of fills) {
    if (!fill || typeof fill !== "object" || !orderIds.has(fill.oid)) continue;
    if (fill.coin !== "ETH" || fill.feeToken !== "USDC" || typeof fill.fee !== "string" || !/^[0-9]+$/.test(String(fill.tid)) || seen.has(String(fill.tid))) throw new VerificationSafetyError("Unexpected or duplicate fill evidence was returned.");
    seen.add(String(fill.tid));
    if (fill.fee.startsWith("-")) decimalToAtoms(fill.fee.slice(1), 18);
    else fees += decimalToAtoms(fill.fee, 18);
  }
  return atomsToDecimal(fees, 18);
}
