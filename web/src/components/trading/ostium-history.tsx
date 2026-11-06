"use client";

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { Fill, LimitOrderEvent, Order } from "@ostium/builder-sdk";
import type { Workspace } from "@/lib/use-workspace";
import { api, displayError } from "@/lib/api";
import { activityTime } from "@/lib/workspace-model";
import { assetAmount, quotePrice, usd } from "@/lib/format";
import { Empty, InlineError, Spinner } from "./primitives";

interface NativeHistory { fills: Fill[]; orders: Order[]; limitHistory: LimitOrderEvent[]; observedAt: number; }
type HistoryView = "fills" | "orders" | "limitHistory";

export function OstiumHistory({ workspace: w }: { workspace: Workspace }) {
  const account = w.session.accounts.find(item => item.venue === "ostium");
  const [data, setData] = useState<NativeHistory | null>(null);
  const [view, setView] = useState<HistoryView>("fills");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setData(null); setError(null);
    if (!account || !w.session.user) return;
    setLoading(true);
    api<{ history: NativeHistory }>(`/api/accounts/${encodeURIComponent(account.id)}/history`, { signal: controller.signal }).then(result => { if (active) setData(result.history); }).catch(cause => { if (active) setError(displayError(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [account?.id, w.session.user?.id, revision]);
  const rows = data?.[view] ?? [];
  return <section className="native-history-panel" aria-label="Ostium venue history"><header><div><h3>Native venue history</h3><p>Observed venue records, separate from this app&apos;s action journal.</p></div><button className="icon-button" type="button" aria-label="Refresh native history" disabled={loading || !account} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} className={loading ? "spin" : ""}/></button></header><nav aria-label="Native history type">{([{ key: "fills", label: "Fills" }, { key: "orders", label: "Orders & oracle status" }, { key: "limitHistory", label: "Entry lifecycle" }] as const).map(item => <button type="button" key={item.key} className={view === item.key ? "selected" : ""} aria-pressed={view === item.key} onClick={() => setView(item.key)}>{item.label}{data ? ` (${data[item.key].length})` : ""}</button>)}</nav><InlineError message={error}/>{loading ? <div className="native-history-loading" role="status"><Spinner/>Loading venue records</div> : !account ? <Empty title="Add an Ostium account">Native history belongs to the connected owner&apos;s Arbitrum Sepolia account.</Empty> : data && !rows.length ? <Empty title="No records returned">The venue did not return any records for this view.</Empty> : data ? <div className="table-scroll"><table><thead><tr><th>Time</th><th>Market</th><th>Action</th><th>Size / collateral</th><th>Price</th><th>Status</th><th>Transaction</th></tr></thead><tbody>{rows.map((record, index) => {
    const order = view === "orders" ? record as Order : undefined;
    const fill = view === "fills" ? record as Fill : undefined;
    const event = view === "limitHistory" ? record as LimitOrderEvent : undefined;
    const timestamp = order?.isPending ? order.initiatedTime : record.timestamp * 1000;
    const hash = order ? order.hash || order.initiatedTx : record.hash;
    const status = event ? event.event : order ? order.isPending ? "Oracle pending" : order.isCancelled ? "Cancelled" : order.hash ? "Execution reported" : "Unavailable" : "Venue-reported fill";
    return <tr key={`${hash}:${record.timestamp}:${index}`}><td>{activityTime(timestamp)}</td><td><strong>{record.pairFrom}/{record.pairTo}</strong><small>Arbitrum Sepolia</small></td><td>{event ? `${event.orderType ?? "Entry"} / ${event.event}` : (record as Fill).action}{order?.cancelReason && <small>{order.cancelReason}</small>}</td><td>{event ? event.collateralUsed === undefined ? "Unavailable" : assetAmount(event.collateralUsed, "USDC") : assetAmount((record as Fill).szi, record.pairFrom)}{fill && ["Close", "StopLoss", "TakeProfit", "CloseDayTrade", "Liquidation"].includes(fill.action) && <small className={Number(fill.closedPnl) < 0 ? "negative" : "positive"}>Realized {usd(fill.closedPnl)}</small>}</td><td>{quotePrice(event?.limitPx ?? (record as Fill).px, record.pairTo)}</td><td>{status}</td><td>{/^0x[\da-f]{64}$/i.test(hash) ? <a className="text-link" href={`https://sepolia.arbiscan.io/tx/${hash}`} target="_blank" rel="noreferrer">{order?.isPending ? "Submission" : "Transaction"}<ExternalLink size={12}/></a> : <span className="muted">No receipt recorded</span>}<details className="native-row-evidence"><summary>Evidence</summary><pre>{JSON.stringify(record, null, 2)}</pre></details></td></tr>;
  })}</tbody></table></div> : !error ? <p className="compact-empty">No history snapshot loaded.</p> : null}</section>;
}
