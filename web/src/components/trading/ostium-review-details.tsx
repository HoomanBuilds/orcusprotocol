import type { PreparedAction } from "@orcus/core";
import { z } from "zod";
import { assetAmount, quotePrice, usd } from "../../lib/format";

const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const signedAmount = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const previewSchema = z.object({ collateralAtOpen: amount.optional(), exposure: amount.optional(), positionSize: amount.optional(), entryPx: amount.optional(), exitPx: amount.optional(), liquidationPx: amount.optional(), priceImpactP: signedAmount.optional(), fees: z.object({ openFee: amount, oracleFee: amount, builderFee: amount, total: amount }).optional(), oracleFee: amount.optional(), netPnl: signedAmount.optional(), received: signedAmount.optional(), rollover: signedAmount.optional() });

export function OstiumReviewDetails({ prepared }: { prepared: PreparedAction }) {
  const scope = prepared.ostium;
  if (!scope) return null;
  const request = prepared.request;
  const [base, quote = "USD"] = request.symbol.split("/");
  const parsed = previewSchema.safeParse(scope.preview);
  const preview = parsed.success ? parsed.data : undefined;
  const approvals = Math.max(0, (prepared.transactions?.length ?? 1) - 1);
  return <section className="native-review-details" aria-label="Native Ostium review"><dl className="preview-details">
    {request.type !== "cancel" && <div><dt>Exact requested amount</dt><dd className="preview-exact-amount">{request.amount} {request.amountUnit === "collateral-usdc" ? "USDC" : base}</dd></div>}
    {request.type !== "cancel" && <><div><dt>Position notional (USD)</dt><dd>{usd(preview?.exposure ?? scope.notionalUsd)}</dd></div><div><dt>Position collateral</dt><dd>{assetAmount(preview?.collateralAtOpen ?? scope.collateralUsd, "USDC")}</dd></div><div><dt>Leverage</dt><dd>{scope.leverage}x</dd></div></>}
    {request.price && <div><dt>Reviewed price ({quote} per {base})</dt><dd>{quotePrice(request.price, quote)}</dd></div>}
    {(preview?.entryPx ?? preview?.exitPx) && <div><dt>Venue execution reference</dt><dd>{quotePrice(preview?.entryPx ?? preview?.exitPx, quote)}</dd></div>}
    {preview?.positionSize !== undefined && <div><dt>Estimated base exposure</dt><dd>{assetAmount(preview.positionSize, base)}</dd></div>}
    {request.takeProfit !== undefined && <div><dt>Take-profit</dt><dd>{request.takeProfit === "0" ? "Explicitly cleared" : quotePrice(request.takeProfit, quote)}</dd></div>}
    {request.stopLoss !== undefined && <div><dt>Stop-loss</dt><dd>{request.stopLoss === "0" ? "Explicitly cleared" : quotePrice(request.stopLoss, quote)}</dd></div>}
    {request.isDayTrade !== undefined && <div><dt>Holding mode</dt><dd>{request.isDayTrade ? "Day trade" : "Overnight-eligible"}</dd></div>}
    {preview?.fees && <><div><dt>Opening fee</dt><dd>{assetAmount(preview.fees.openFee, "USDC")}</dd></div><div><dt>Oracle fee</dt><dd>{assetAmount(preview.fees.oracleFee, "USDC")}</dd></div><div><dt>Builder fee</dt><dd>{assetAmount(preview.fees.builderFee, "USDC")}</dd></div><div><dt>Total opening fees</dt><dd>{assetAmount(preview.fees.total, "USDC")}</dd></div></>}
    {preview?.oracleFee !== undefined && <div><dt>Oracle-fee allowance</dt><dd>{assetAmount(preview.oracleFee, "USDC")}</dd></div>}
    {preview?.netPnl !== undefined && <div><dt>Venue close preview P&amp;L</dt><dd>{usd(preview.netPnl)}</dd></div>}
    {preview?.received !== undefined && <div><dt>Estimated USDC returned</dt><dd>{assetAmount(preview.received, "USDC")}</dd></div>}
    {preview?.liquidationPx !== undefined && <div><dt>Liquidation reference</dt><dd>{quotePrice(preview.liquidationPx, quote)}</dd></div>}
    <div><dt>Required USDC allowance</dt><dd>{assetAmount(scope.requiredAllowanceUsd, "USDC")}</dd></div>
    <div><dt>Wallet sequence</dt><dd>{approvals ? `${approvals} exact approval ${approvals === 1 ? "transaction" : "transactions"}, then native action` : "Native action; existing allowance checked"}</dd></div>
  </dl><p className="warning-note">{request.mode === "agent" ? "The authorized agent signer" : "Your owner wallet"} pays Arbitrum Sepolia ETH gas. Approval and trade are separate, non-atomic transactions. A submitted transaction can still await the native oracle callback.</p>{request.isDayTrade && <p className="warning-note">Day trades can be automatically closed before the market closes. The live venue schedule applies.</p>}</section>;
}
