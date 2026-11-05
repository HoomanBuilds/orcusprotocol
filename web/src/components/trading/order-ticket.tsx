"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  LockKeyhole,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { tradeRequestSchema, type TradeRequest } from "@orcus/core";
import type { Workspace } from "@/lib/use-workspace";
import { number, usd } from "@/lib/format";
import { displayError } from "@/lib/api";
import { Field, InlineError, Spinner } from "./primitives";

export function OrderTicket({
  workspace: w,
  onSetup,
}: {
  workspace: Workspace;
  onSetup: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<
    "market" | "limit" | "stop-loss" | "take-profit"
  >("market");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    setAmount("");
    setPrice("");
    setFormError(null);
    setOrderType("market");
    setReduceOnly(false);
  }, [w.venue, w.symbol]);
  const spot = w.venue === "uniswap";
  const asset = w.activeMarket?.baseAsset ?? w.symbol.split("/")[0];
  const quote = w.activeMarket?.quoteAsset ?? "USDC";
  const inputAsset = spot && side === "buy" ? quote : asset;
  const balance = w.portfolio.balances.find(
    (item) =>
      item.accountId === w.account?.id &&
      item.symbol === (spot ? inputAsset : "USDC"),
  );
  const currentLeverage = w.portfolio.positions.find(
    (position) =>
      position.accountId === w.account?.id && position.symbol === w.symbol,
  )?.leverage;
  const estimated =
    w.activeMarket && Number(amount) > 0
      ? Number(amount) * Number(w.activeMarket.midPrice)
      : undefined;

  async function prepare() {
    setFormError(null);
    if (!w.account) {
      onSetup();
      return;
    }
    try {
      const request: TradeRequest = tradeRequestSchema.parse({
        accountId: w.account.id,
        venue: w.venue,
        type: spot ? "swap" : orderType,
        symbol: w.symbol,
        side,
        amount,
        slippageBps: Math.round(Number(slippage) * 100),
        reduceOnly:
          !spot &&
          (reduceOnly ||
            orderType === "stop-loss" ||
            orderType === "take-profit"),
        mode: "manual",
        ...(!spot && orderType === "limit" ? { price } : {}),
        ...(!spot && (orderType === "stop-loss" || orderType === "take-profit")
          ? { triggerPrice: price }
          : {}),
      });
      await w.prepare(request);
    } catch (cause) {
      setFormError(
        cause && typeof cause === "object" && "issues" in cause
          ? "Check the amount, price and slippage before requesting a quote."
          : displayError(cause),
      );
    }
  }

  return (
    <section className="order-ticket">
      <div className="section-title">
        <h2>{spot ? "Swap tokens" : "Place an order"}</h2>
        <SlidersHorizontal size={14} />
      </div>
      <div className="segmented side-toggle">
        <button
          type="button"
          className={side === "buy" ? "selected buy" : ""}
          onClick={() => setSide("buy")}
        >
          {spot ? "Buy" : "Long / Buy"}
        </button>
        <button
          type="button"
          className={side === "sell" ? "selected sell" : ""}
          onClick={() => setSide("sell")}
        >
          {spot ? "Sell" : "Short / Sell"}
        </button>
      </div>
      {!spot && (
        <div className="order-type-tabs">
          {(["market", "limit", "stop-loss", "take-profit"] as const).map(
            (value) => (
              <button
                key={value}
                type="button"
                className={value === orderType ? "selected" : ""}
                onClick={() => setOrderType(value)}
              >
                {value === "stop-loss"
                  ? "Stop"
                  : value === "take-profit"
                    ? "TP"
                    : value === "market"
                      ? "Market"
                      : "Limit"}
              </button>
            ),
          )}
        </div>
      )}
      <div className="ticket-account">
        <span>{spot ? "Smart account" : "Trading account"}</span>
        <span>
          {w.account ? (
            <>
              <i className="dot good" />
              Connected
            </>
          ) : (
            "Not connected"
          )}
        </span>
      </div>
      <Field
        label={spot ? "You pay" : "Position size"}
        hint={
          spot
            ? `Input token: ${inputAsset}. Quote uses the selected testnet pool.`
            : estimated !== undefined
              ? `Estimated notional ${usd(estimated)}`
              : "Enter an amount to preview your order."
        }
      >
        <div className="amount-input">
          <input
            aria-label="Order amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <span>{inputAsset}</span>
        </div>
      </Field>
      {!spot && orderType !== "market" && (
        <Field label={orderType === "limit" ? "Limit price" : "Trigger price"}>
          <div className="amount-input compact">
            <input
              aria-label="Order price"
              inputMode="decimal"
              placeholder="0.00"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
            <span>{quote}</span>
          </div>
        </Field>
      )}
      {!spot && (
        <div className="leverage">
          <div>
            <span>Current venue leverage</span>
            <b>{currentLeverage ? `${currentLeverage}x` : "Venue default"}</b>
          </div>
          <p className="fine-print">
            Orders use your existing leverage.{" "}
            <a
              className="text-link"
              href="https://app.hyperliquid-testnet.xyz/trade"
              target="_blank"
              rel="noreferrer"
            >
              Manage at venue
            </a>
          </p>
        </div>
      )}
      <Field label="Slippage tolerance">
        <div className="slippage">
          <input
            aria-label="Slippage percentage"
            inputMode="decimal"
            value={slippage}
            onChange={(event) => setSlippage(event.target.value)}
          />
          <span>%</span>
          <span className="muted">Max 5%</span>
        </div>
      </Field>
      {!spot && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={
              reduceOnly ||
              orderType === "stop-loss" ||
              orderType === "take-profit"
            }
            disabled={orderType === "stop-loss" || orderType === "take-profit"}
            onChange={(event) => setReduceOnly(event.target.checked)}
          />
          <span>Reduce only</span>
          <span title="Only reduces an existing position and cannot reverse your exposure.">
            <ShieldCheck size={13} />
          </span>
        </label>
      )}
      <div className="ticket-summary">
        <div>
          <span>Available</span>
          <span>
            {balance ? `${number(balance.amount, 4)} ${balance.symbol}` : "--"}
          </span>
        </div>
        <div>
          <span>Execution</span>
          <span>{spot ? "Uniswap V3" : "Hyperliquid testnet"}</span>
        </div>
        <div>
          <span>Network fee</span>
          <span>Shown before signing</span>
        </div>
      </div>
      <InlineError message={formError} />
      {!w.session.user ? (
        <button
          className="button primary full"
          type="button"
          onClick={() => void w.connect()}
          disabled={w.connecting}
        >
          {w.connecting ? (
            <>
              <Spinner />
              Sign in with wallet
            </>
          ) : (
            "Connect wallet to trade"
          )}
        </button>
      ) : !w.account ? (
        <button className="button primary full" type="button" onClick={onSetup}>
          Set up trading account
        </button>
      ) : (
        <button
          className={`button full ${side === "buy" ? "primary" : "sell-button"}`}
          type="button"
          disabled={
            w.preparing || w.executing || !amount || Number(amount) <= 0
          }
          onClick={() => void prepare()}
        >
          {w.preparing ? (
            <>
              <Spinner />
              Preparing quote
            </>
          ) : (
            <>
              {spot ? "Review swap" : "Review order"}
              <ChevronDown size={14} className="rotate-left" />
            </>
          )}
        </button>
      )}
      <p className="ticket-note">
        <LockKeyhole size={12} />
        You stay in control. Every manual trade is signed in your wallet.
      </p>
    </section>
  );
}
