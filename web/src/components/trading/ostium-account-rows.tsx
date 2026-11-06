"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { OpenOrder, Position } from "@orcus/core";
import type { Workspace } from "@/lib/use-workspace";
import { ostiumOrderRequest, ostiumPositionRequest, positionSizeAtPercent } from "@/lib/ostium-ux";
import { assetAmount, quotePrice, usd } from "@/lib/format";
import { Badge, Field, InlineError } from "./primitives";

function inputError(cause: unknown) {
  return cause && typeof cause === "object" && "issues" in cause ? "Review the amount, price and both protective levels before continuing." : cause instanceof Error ? cause.message : "The native action could not be reviewed.";
}

export function OstiumPositionRow({ position, workspace: w, allowanceControls }: { position: Position; workspace: Workspace; allowanceControls?: (amount: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"reduce" | "stop-loss" | "take-profit" | "add-collateral" | "remove-collateral">("reduce");
  const [amount, setAmount] = useState("");
  const [percentage, setPercentage] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [base, quote = "USD"] = position.symbol.split("/");
  const market = w.markets.find(item => item.venue === "ostium" && item.symbol === position.symbol && Date.now() - item.observedAt < 30_000);
  const blocked = w.preparing || w.executing || w.actions.some(action => action.accountId === position.accountId && (["submitting", "submitted-unknown"].includes(action.status) || action.approvals?.some(step => ["submitting", "pending", "submitted-unknown"].includes(step.status))));
  const collateral = type === "add-collateral" || type === "remove-collateral";
  let reduction: string | undefined;
  try { reduction = positionSizeAtPercent(position.size, percentage); } catch {}

  function review(action: Parameters<typeof ostiumPositionRequest>[1]) {
    try { setError(null); void w.prepare(ostiumPositionRequest(position, action, amount, percentage)); }
    catch (cause) { setError(inputError(cause)); setOpen(true); }
  }

  return <>
    <tr><td><strong>{position.symbol}</strong><small>Ostium / Arbitrum Sepolia</small></td><td><Badge tone={position.side === "long" ? "good" : "bad"}>{position.side}{position.leverage ? ` ${position.leverage}x` : ""}</Badge></td><td>{assetAmount(position.size, base)}</td><td>{quotePrice(position.entryPrice, quote)}</td><td title="Current public pair reference, not a guaranteed fill">{quotePrice(position.markPrice ?? market?.midPrice, quote)}</td><td className={Number(position.unrealizedPnl) < 0 ? "negative" : "positive"}>{usd(position.unrealizedPnl)}</td><td><div className="table-actions"><button type="button" disabled={blocked} onClick={() => setOpen(value => !value)}>{open ? "Hide controls" : "Manage"}</button><button type="button" disabled={blocked} onClick={() => review("close")}>Close</button></div></td></tr>
    {open && <tr className="manage-row"><td colSpan={7}><div className="native-position-management">
      <dl className="native-position-facts"><div><dt>Collateral</dt><dd>{position.collateralUsd === undefined ? "Unavailable" : `${assetAmount(position.collateralUsd, "USDC")}`}</dd></div><div><dt>Notional</dt><dd>{usd(position.notionalUsd)}</dd></div><div><dt>Liquidation reference</dt><dd>{quotePrice(position.liquidationPrice, quote)}</dd></div><div><dt>Stop-loss</dt><dd>{position.stopLoss === "0" ? "Not set" : quotePrice(position.stopLoss, quote)}</dd></div><div><dt>Take-profit</dt><dd>{position.takeProfit === "0" ? "Not set" : quotePrice(position.takeProfit, quote)}</dd></div></dl>
      <div className="form-grid"><Field label="Position action"><select value={type} onChange={event => { setType(event.target.value as typeof type); setAmount(""); setError(null); }}><option value="reduce">Reduce position</option><option value="stop-loss">Change stop-loss</option><option value="take-profit">Change take-profit</option><option value="add-collateral">Add collateral</option><option value="remove-collateral">Remove collateral (owner only)</option></select></Field>{type === "reduce" ? <Field label="Reduce by"><select value={percentage} onChange={event => setPercentage(Number(event.target.value))}><option value={25}>25%</option><option value={50}>50%</option><option value={75}>75%</option></select></Field> : <Field label={collateral ? "Collateral amount (USDC)" : `${type === "stop-loss" ? "Stop-loss" : "Take-profit"} (${quote} per ${base})`}><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder={collateral ? "0.00" : "Price, or 0 to clear"}/></Field>}</div>
      {type === "reduce" && <p className="fine-print">Review closing {assetAmount(reduction, base)}. The current position and venue preview are checked again.</p>}
      {!collateral && type !== "reduce" && amount === "0" && <p className="warning-note">This explicitly removes the selected protective level. The other level is not changed.</p>}
      {collateral && <p className="fine-print">USDC collateral is separate from base size and notional exposure. Removal requires your owner signature and the venue's current withdrawal limit.</p>}
      {type === "add-collateral" && <details className="technical-limits"><summary>Approve exact USDC allowance before adding collateral</summary>{allowanceControls ? allowanceControls(amount) : <Link className="text-link" href="/settings?section=accounts">Open native account allowance controls</Link>}</details>}
      <InlineError message={error}/><button className="button secondary small" type="button" disabled={blocked || (type === "reduce" ? !reduction : !amount)} onClick={() => review(type)}>Review {type === "reduce" ? "reduction" : type === "remove-collateral" ? "owner withdrawal" : type === "add-collateral" ? "collateral addition" : "protection change"}</button><p className="fine-print">Owner-paid Arbitrum Sepolia gas. Any exact oracle-fee allowance is reviewed separately from the trade.</p>
    </div></td></tr>}
  </>;
}

export function OstiumOrderRow({ order, workspace: w }: { order: OpenOrder; workspace: Workspace }) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState(order.price ?? "");
  const [takeProfit, setTakeProfit] = useState(order.takeProfit ?? "");
  const [stopLoss, setStopLoss] = useState(order.stopLoss ?? "");
  const [error, setError] = useState<string | null>(null);
  const [base, quote = "USD"] = order.symbol.split("/");
  const pending = order.id.startsWith("pending-") || order.type.startsWith("pending-");
  const editable = !pending && (order.type === "limit" || order.type === "stop");
  const cancellable = !pending || /^pending-(open|close):\d+$/.test(order.id);
  const blocked = w.preparing || w.executing;
  function review(edit: boolean) { try { setError(null); void w.prepare(ostiumOrderRequest(order, edit ? { price, takeProfit, stopLoss } : undefined)); } catch (cause) { setError(inputError(cause)); setEditing(true); } }
  return <><tr><td><strong>{order.symbol}</strong><small>{pending ? "Oracle action pending" : "Ostium resting entry"}</small></td><td>{order.type}</td><td className={order.side === "buy" ? "positive" : "negative"}>{order.side}</td><td>{assetAmount(order.size, base)}{order.collateralUsd && <small>{assetAmount(order.collateralUsd, "USDC")} collateral</small>}</td><td>{quotePrice(order.price, quote)}</td><td>{order.reduceOnly ? "Yes" : "No"}</td><td><div className="table-actions">{editable && <button type="button" disabled={blocked} onClick={() => setEditing(value => !value)}>Edit</button>}{cancellable && <button type="button" disabled={blocked} onClick={() => review(false)}>{pending ? "Review timeout cancel" : "Cancel"}</button>}{!cancellable && <Link className="text-link" href="/activity?status=pending">Check progress</Link>}</div></td></tr>{editing && <tr className="manage-row"><td colSpan={7}><div className="native-order-management">{editable && <><div className="form-grid"><Field label={`Entry price (${quote} per ${base})`}><input inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)}/></Field><Field label={`Take-profit (${quote})`}><input inputMode="decimal" value={takeProfit} onChange={event => setTakeProfit(event.target.value)} placeholder="0 explicitly clears"/></Field><Field label={`Stop-loss (${quote})`}><input inputMode="decimal" value={stopLoss} onChange={event => setStopLoss(event.target.value)} placeholder="0 explicitly clears"/></Field></div><p className="fine-print">Review both protective levels. Zero explicitly clears a level; it is never inferred from missing data.</p><button className="button secondary small" type="button" disabled={blocked || !price || takeProfit === "" || stopLoss === ""} onClick={() => review(true)}>Review order changes</button></>}<InlineError message={error}/></div></td></tr>}</>;
}
