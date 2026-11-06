"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ActionRecord, Position, TradeRequest } from "@orcus/core";
import type { Workspace } from "@/lib/use-workspace";
import { assetAmount, number, time, usd } from "@/lib/format";
import { AssetIcon } from "../workspace/asset-icon";
import { OstiumOrderRow, OstiumPositionRow } from "./ostium-account-rows";
import { OstiumHistory } from "./ostium-history";
import { OstiumAllowanceControls } from "../agent/ostium-allowance-controls";
import { balanceRole, venueName, venuePresentation } from "@/lib/venue-presentation";
import { actionRecovery } from "@/lib/trade-ux";
import { displayError } from "@/lib/api";
import { Badge, Empty, InlineError, Spinner, Status } from "./primitives";

function half(value: string): string {
  const [whole, decimal = ""] = value.split(".");
  const precision = Math.max(decimal.length, 1);
  const units = BigInt(`${whole}${decimal.padEnd(precision, "0")}`) / 2n;
  const result = units.toString().padStart(precision + 1, "0");
  return `${result.slice(0, -precision)}.${result.slice(-precision)}`;
}

function PositionRow({
  position,
  workspace: w,
}: {
  position: Position;
  workspace: Workspace;
}) {
  const [management, setManagement] = useState(false);
  const [trigger, setTrigger] = useState("");
  function change(type: TradeRequest["type"], amount = position.size) {
    void w.prepare({
      accountId: position.accountId,
      venue: position.venue,
      type,
      symbol: position.symbol,
      side: position.side === "long" ? "sell" : "buy",
      amount,
      slippageBps: 50,
      reduceOnly: true,
      mode: "manual",
      ...(type === "stop-loss" || type === "take-profit"
        ? { triggerPrice: trigger }
        : {}),
    });
  }
  return (
    <>
      <tr>
        <td>
          <span className="table-asset-label"><AssetIcon symbol={position.symbol} size={25}/><strong>{position.symbol}</strong></span>
          <small>Hyperliquid perpetual</small>
        </td>
        <td>
          <Badge tone={position.side === "long" ? "good" : "bad"}>
            {position.side}
            {position.leverage ? ` ${position.leverage}x` : ""}
          </Badge>
        </td>
        <td>{number(position.size, 6)}</td>
        <td>{usd(position.entryPrice)}</td>
        <td>{usd(position.markPrice)}</td>
        <td
          className={
            Number(position.unrealizedPnl) >= 0 ? "positive" : "negative"
          }
        >
          {usd(position.unrealizedPnl)}
        </td>
        <td>
          <div className="table-actions">
            <button
              type="button"
              disabled={w.preparing || w.executing}
              onClick={() => setManagement((value) => !value)}
            >
              Manage
            </button>
            <button
              type="button"
              disabled={w.preparing || w.executing}
              onClick={() => change("close")}
            >
              Close
            </button>
          </div>
        </td>
      </tr>
      {management && (
        <tr className="manage-row">
          <td colSpan={7}>
            <div className="position-management">
              <span className="muted">Owner controls / reduce only</span>
              <button
                className="button secondary small"
                type="button"
                disabled={w.preparing || w.executing || Number(half(position.size)) <= 0}
                onClick={() => change("reduce", half(position.size))}
              >
                Reduce 50%
              </button>
              <label>
                Trigger price
                <input
                  aria-label={`${position.symbol} protective order price`}
                  inputMode="decimal"
                  value={trigger}
                  placeholder="0.00"
                  onChange={(event) => setTrigger(event.target.value)}
                />
              </label>
              <button
                className="button secondary small"
                type="button"
                disabled={w.preparing || w.executing || Number(trigger) <= 0}
                onClick={() => change("stop-loss")}
              >
                Set stop-loss
              </button>
              <button
                className="button secondary small"
                type="button"
                disabled={w.preparing || w.executing || Number(trigger) <= 0}
                onClick={() => change("take-profit")}
              >
                Set take-profit
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function ActivityTable({ actions, onRefresh }: { actions: ActionRecord[]; onRefresh?: () => Promise<unknown> }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function checkStatus() {
    if (checking || !onRefresh) return;
    setChecking(true); setError(null);
    try { await onRefresh(); } catch (cause) { setError(displayError(cause)); }
    finally { setChecking(false); }
  }
  if (!actions.length)
    return (
      <Empty title="Your execution history starts here">
        Manual, agent and automated actions appear in one timeline, with the
        actual venue result.
      </Empty>
    );
  return (
    <div className="table-scroll">
      {actions.some(action => ["submitting", "submitted-unknown", "pending", "partially-filled"].includes(action.status)) && <div className="warning-note"><p>A submitted action is still resolving. Refresh its existing record instead of placing it again.</p>{onRefresh && <button className="button secondary small" type="button" disabled={checking} onClick={() => void checkStatus()}>{checking ? <Spinner /> : null}Check existing action status</button>}</div>}
      <InlineError message={error} />
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Initiated by</th>
            <th>Venue</th>
            <th>Status</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => (
            <tr key={action.id}>
              <td>{time(action.createdAt)}</td>
              <td>
                <strong>{action.request.symbol}</strong>
                <small>
                  {action.request.type} / {action.request.side}{" "}
                  {number(action.request.amount, 6)}
                </small>
                {actionRecovery(action.status) && (
                  <small className={action.status === "rejected" ? "negative" : "muted"}>
                    {actionRecovery(action.status)}
                  </small>
                )}
              </td>
              <td>
                <Badge>{action.initiator}</Badge>
              </td>
              <td>
                {venueName(action.request.venue)}
              </td>
              <td>
                <Status value={action.status} />
              </td>
              <td>
                {action.transactionHash ? (
                  <a
                    className="text-link"
                    target="_blank"
                    rel="noreferrer"
                    href={`${venuePresentation[action.request.venue].explorer ?? "https://sepolia.etherscan.io"}/tx/${action.transactionHash}`}
                  >
                    Transaction <ExternalLink size={11} />
                  </a>
                ) : action.userOperationHash ? (
                  <span className="muted" title={action.userOperationHash}>Signed operation recorded; awaiting its transaction receipt</span>
                ) : action.orderId ? (
                  <span className="muted">Order {action.orderId}</span>
                ) : (
                  <span className="muted">{["submitting", "submitted-unknown", "pending"].includes(action.status) ? "No confirmed receipt yet" : "No submission receipt"}</span>
                )}
                {action.providerRequestId && (
                  <small title={action.providerRequestId}>
                    0G request: {action.providerRequestId.slice(0, 14)}...
                  </small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AccountTables({ workspace: w }: { workspace: Workspace }) {
  const [tab, setTab] = useState("positions");
  const positions = w.portfolio.positions;
  const orders = w.portfolio.orders;
  const stale = w.portfolio.observedAt > 0 && Date.now() - w.portfolio.observedAt > 60_000;
  return (
    <section className="account-tables">
      <div className="table-tabs" role="tablist" aria-label="Account details">
        {[
          { id: "positions", label: "Positions", count: positions.length },
          { id: "orders", label: "Open orders", count: orders.length },
          {
            id: "balances",
            label: "Balances",
            count: w.portfolio.balances.length,
          },
          { id: "activity", label: "Activity", count: w.actions.length },
          ...(w.session.accounts.some(account => account.venue === "ostium") ? [{ id: "venue-history", label: "Native history", count: undefined }] : []),
        ].map((item) => (
          <button
            role="tab"
            aria-selected={tab === item.id}
            type="button"
            key={item.id}
            className={tab === item.id ? "selected" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            <span>{item.count}</span>
          </button>
        ))}
        <span className="table-freshness">
          {w.portfolio.observedAt
            ? `${stale ? "Stale snapshot" : "Updated"} ${time(w.portfolio.observedAt)}`
            : "No account loaded"}
        </span>
      </div>
      {stale && <p className="warning-note">These account values are stale. Refresh before relying on them; any new action will still require fresh preparation.</p>}
      {!w.session.user ? (
        <Empty
          title="Your accounts, in one place"
          action={
            <button
              className="button secondary small"
              type="button"
              onClick={() => void w.connect()}
            >
              Connect wallet
            </button>
          }
        >
          Connect and sign in to see balances, positions and orders. Connecting
          never grants trading access.
        </Empty>
      ) : tab === "positions" ? (
        positions.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th>Size</th>
                  <th>Entry price</th>
                  <th>Mark price</th>
                  <th>Unrealized P&L</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  position.venue === "ostium" ? <OstiumPositionRow key={position.id} position={position} workspace={w} allowanceControls={amount => {
                    const account = w.session.accounts.find(item => item.id === position.accountId && item.venue === "ostium");
                    return account ? <OstiumAllowanceControls account={account} workspace={w} initialAmount={amount}/> : null;
                  }}/> : <PositionRow
                    key={position.id}
                    position={position}
                    workspace={w}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No open positions">
            Positions opened here or on the supported venue account will appear
            here. You and your agent can manage the same positions.
          </Empty>
        )
      ) : tab === "orders" ? (
        orders.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Type</th>
                  <th>Side</th>
                  <th>Size</th>
                  <th>Price</th>
                  <th>Reduce only</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  order.venue === "ostium" ? <OstiumOrderRow key={order.id} order={order} workspace={w}/> : <tr key={order.id}>
                    <td>
                      <span className="table-asset-label"><AssetIcon symbol={order.symbol} size={25}/><strong>{order.symbol}</strong></span>
                    </td>
                    <td>{order.type}</td>
                    <td
                      className={order.side === "buy" ? "positive" : "negative"}
                    >
                      {order.side}
                    </td>
                    <td>{number(order.size, 6)}</td>
                    <td>{usd(order.price)}</td>
                    <td>{order.reduceOnly ? "Yes" : "No"}</td>
                    <td>
                      <button
                        className="text-button"
                        type="button"
                        disabled={w.preparing || w.executing}
                        onClick={() =>
                          void w.prepare({
                            accountId: order.accountId,
                            venue: order.venue,
                            type: "cancel",
                            symbol: order.symbol,
                            side: order.side,
                            amount: order.size,
                            orderId: order.id,
                            slippageBps: 50,
                            reduceOnly: false,
                            mode: "manual",
                          })
                        }
                      >
                        Cancel order
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No resting orders">
            Limit and protective orders appear here after the venue accepts
            them. An accepted order is not necessarily filled.
          </Empty>
        )
      ) : tab === "balances" ? (
        w.portfolio.balances.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Account</th>
                  <th>Amount</th>
                  <th>USD value</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {w.portfolio.balances.map((balance) => (
                  <tr key={`${balance.accountId}:${balance.symbol}`}>
                    <td>
                      <span className="table-asset-label"><AssetIcon symbol={balance.symbol} size={25}/><strong>{balance.symbol}</strong></span>
                    </td>
                    <td>
                      {w.session.accounts.find(
                        (account) => account.id === balance.accountId,
                      )?.venue ?? "Trading account"}
                    </td>
                    <td>{assetAmount(balance.amount, balance.symbol)}</td>
                    <td>{balance.usdValue === undefined ? "Unavailable" : `${usd(balance.usdValue)} testnet`}</td>
                    <td>
                      <Badge>{balanceRole(w.session.accounts.find(account => account.id === balance.accountId)?.venue, balance.symbol)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No balances loaded">
            Add your trading account in settings to load its actual token
            balances. Spot holdings are separate from perpetual positions.
          </Empty>
        )
      ) : tab === "venue-history" ? <OstiumHistory workspace={w}/> : (
        <ActivityTable actions={w.actions} onRefresh={w.refresh} />
      )}
    </section>
  );
}
