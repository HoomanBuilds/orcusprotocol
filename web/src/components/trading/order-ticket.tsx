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
import { tradingGasStatus } from "@/lib/trade-ux";
import { Address, Field, InlineError, Spinner } from "./primitives";
import { AssetIcon } from "../workspace/asset-icon";

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
  const [nativeInput, setNativeInput] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    setAmount("");
    setPrice("");
    setFormError(null);
    setOrderType("market");
    setReduceOnly(false);
    setNativeInput(false);
  }, [w.venue, w.symbol]);
  const spot = w.venue === "uniswap";
  const gas = tradingGasStatus(w.walletConfig, w.venue);
  const uncertain = w.actions.some(action => action.accountId === w.account?.id && ["submitting", "submitted-unknown"].includes(action.status));
  const asset = w.activeMarket?.baseAsset ?? w.symbol.split("/")[0];
  const quote = w.activeMarket?.quoteAsset ?? "USDC";
  const nativeAvailable = spot && side === "sell" && w.symbol === "WETH/USDC" && !!w.account?.smartAccountAddress;
  const inputAsset = nativeAvailable && nativeInput ? "ETH" : spot && side === "buy" ? quote : asset;
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
        ...(nativeAvailable && nativeInput ? { nativeInput: true } : {}),
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
          onClick={() => { setSide("buy"); setAmount(""); setNativeInput(false); }}
        >
          {spot ? "Buy" : "Long / Buy"}
        </button>
        <button
          type="button"
          className={side === "sell" ? "selected sell" : ""}
          onClick={() => { setSide("sell"); setAmount(""); setNativeInput(false); }}
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
        <span>{spot ? "Sepolia trading account" : "Hyperliquid testnet account"}</span>
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
      {w.account && <p className="fine-print">Trades use <Address value={w.account.address} explorer={spot ? "https://sepolia.etherscan.io" : undefined} />. This is the same account your approved agent manages.</p>}
      {nativeAvailable && <label className="checkbox"><input type="checkbox" checked={nativeInput} disabled={w.preparing || w.executing} onChange={event => { setNativeInput(event.target.checked); setAmount(""); }} />Pay with native Sepolia ETH. Wrap and swap in one atomic account operation.</label>}
      {spot && side === "buy" && <p className="fine-print">Buying this pair receives WETH, not native ETH. No automatic unwrap or cross-chain transfer is included.</p>}
      <Field
        label={spot ? "You pay" : "Position size"}
        hint={
          spot
            ? `Input token: ${inputAsset} from your trading account. ${nativeAvailable && nativeInput ? "ETH is wrapped into WETH inside the same swap operation." : "Quote uses the selected testnet pool."}`
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
          <span><AssetIcon symbol={inputAsset} size={22}/>{inputAsset}</span>
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
          <span>{spot ? "Uniswap V3 / Sepolia" : "Hyperliquid testnet"}</span>
        </div>
        <div>
          <span>{spot ? "Trading gas" : "Fees"}</span>
          <span>{gas.label}</span>
        </div>
      </div>
      {spot && <p className={gas.ready ? "fine-print" : "warning-note"}>{gas.detail} Your first wallet-to-account deposit is separate and uses owner-paid gas. No 0G is needed to trade.</p>}
      {uncertain && <p className="warning-note">An earlier submission for this account is unresolved. Check its existing record in Activity before trading again.</p>}
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
            w.preparing || w.executing || uncertain || !amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0
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
        Manual trades need your owner-wallet signature. Agent access is a separate, revocable approval. No private key is shared.
      </p>
    </section>
  );
}
