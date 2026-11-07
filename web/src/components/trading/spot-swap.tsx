"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ChevronDown } from "lucide-react";
import { tradeRequestSchema } from "@orcus/core";
import { parseUnits } from "viem";
import type { Workspace } from "@/lib/use-workspace";
import { assetAmount, statusLabel, time } from "@/lib/format";
import { displayError } from "@/lib/api";
import { tradingGasStatus } from "@/lib/trade-ux";
import { AssetIcon, ProtocolIcon } from "../workspace/asset-icon";
import { Address, InlineError, Spinner } from "./primitives";
import styles from "./spot-swap.module.css";

export type SwapInput = "USDC" | "WETH" | "ETH";

export function swapInputIssue(amount: string, token: SwapInput, balance?: string): string | undefined {
  if (!amount) return undefined;
  const decimals = token === "USDC" ? 6 : 18;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) || amount.length > 80) return "Enter a valid amount.";
  if ((amount.split(".")[1]?.length ?? 0) > decimals) return `Use up to ${decimals} decimal places for ${token}.`;
  try {
    const value = parseUnits(amount, decimals);
    if (value <= 0n) return "Enter an amount above zero.";
    if (balance !== undefined && value > parseUnits(balance, decimals)) return `Not enough ${token} in your trading account.`;
  } catch { return "Enter a valid amount."; }
}

export function swapRequest(accountId: string, token: SwapInput, amount: string, slippage: string) {
  return tradeRequestSchema.parse({
    accountId, venue: "uniswap", type: "swap", symbol: "WETH/USDC",
    side: token === "USDC" ? "buy" : "sell", amount,
    slippageBps: Math.round(Number(slippage) * 100), reduceOnly: false, mode: "manual",
    ...(token === "ETH" ? { nativeInput: true } : {}),
  });
}

export function SpotSwap({ workspace: w, onSetup }: { workspace: Workspace; onSetup: () => void }) {
  const [token, setToken] = useState<SwapInput>("USDC");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [formError, setFormError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { setToken("USDC"); setAmount(""); setFormError(null); }, [w.account?.id]);

  const account = w.account?.venue === "uniswap" ? w.account : undefined;
  const output = token === "USDC" ? "WETH" : "USDC";
  const balanceError = w.resourceErrors.portfolio || w.portfolio.errors?.find(error => error.accountId === account?.id)?.message;
  const staleBalances = !w.demoMode && w.portfolio.observedAt > 0 && Date.now() - w.portfolio.observedAt > 60_000;
  const balances = account && !balanceError ? w.portfolio.balances.filter(item => item.accountId === account.id) : [];
  const balance = balances.find(item => item.symbol === token)?.amount;
  const gasBalance = balances.find(item => item.symbol === "ETH")?.amount;
  const actions = account ? w.actions.filter(action => action.accountId === account.id && action.request.venue === "uniswap").sort((a, b) => b.createdAt - a.createdAt) : [];
  const unresolved = actions.find(action => ["submitting", "submitted-unknown", "pending"].includes(action.status));
  const gas = tradingGasStatus(w.walletConfig, "uniswap");
  const busy = w.preparing || w.executing || !!w.preview;
  const inputIssue = swapInputIssue(amount, token, balance);
  const slippageValid = /^\d+(?:\.\d{1,2})?$/.test(slippage) && Number(slippage) >= 0.01 && Number(slippage) <= 5;

  function changeToken(next: SwapInput) { setToken(next); setAmount(""); setFormError(null); }
  async function prepare() {
    if (!account || busy || unresolved || !amount || inputIssue || !slippageValid || !gas.ready) return;
    setFormError(null);
    try { await w.prepare(swapRequest(account.id, token, amount, slippage)); }
    catch (cause) { setFormError(displayError(cause)); }
  }
  async function checkStatus() {
    if (checking) return;
    setChecking(true); setFormError(null);
    try { await w.refresh(); } catch (cause) { setFormError(displayError(cause)); }
    finally { setChecking(false); }
  }

  return <div className={styles.page} data-venue="uniswap">
    <div className={styles.toolbar}>
      <label className={styles.venue}><ProtocolIcon name="uniswap" size={24}/><select aria-label="Trading venue" value="uniswap" disabled={busy} onChange={event => w.setVenue(event.target.value as typeof w.venue)}><option value="hyperliquid">Hyperliquid</option><option value="uniswap">Uniswap</option><option value="ostium">Ostium</option></select><ChevronDown size={14} aria-hidden="true"/></label>
      <span className={styles.network}>Sepolia</span>
    </div>
    <div className={styles.column}>
      <section className={styles.card} aria-labelledby="swap-title">
        <header className={styles.heading}><h1 id="swap-title">Swap</h1><span>Uniswap V3</span></header>
        <form onSubmit={event => { event.preventDefault(); void prepare(); }}>
          <div className={styles.tokenBox}>
            <label htmlFor="swap-amount" className={styles.label}>You pay</label>
            <div className={styles.amountRow}>
              <input id="swap-amount" aria-label="You pay amount" autoComplete="off" spellCheck={false} inputMode="decimal" placeholder="0" value={amount} disabled={busy} onChange={event => { setAmount(event.target.value); setFormError(null); }}/>
              <label className={styles.tokenSelect}><AssetIcon symbol={token} size={26}/><select aria-label="Pay token" value={token} disabled={busy} onChange={event => changeToken(event.target.value as SwapInput)}><option value="USDC">USDC</option><option value="WETH">WETH</option>{account?.smartAccountAddress && <option value="ETH">ETH</option>}</select><ChevronDown size={13} aria-hidden="true"/></label>
            </div>
            <div className={styles.balanceRow}><span>Balance: {balance === undefined ? "--" : assetAmount(balance, token)}</span>{balance !== undefined && token !== "ETH" && Number(balance) > 0 && <button type="button" disabled={busy} onClick={() => setAmount(balance)}>Max</button>}</div>
          </div>
          <div className={styles.directionRow}><button type="button" className={styles.reverse} aria-label="Reverse swap direction" disabled={busy} onClick={() => changeToken(output)}><ArrowDown size={18} aria-hidden="true"/></button></div>
          <div className={`${styles.tokenBox} ${styles.receive}`}>
            <span className={styles.label}>You receive</span>
            <div className={styles.amountRow}><span className={styles.receiveAmount} aria-label="Receive amount available after review">--</span><span className={styles.outputToken}><AssetIcon symbol={output} size={26}/>{output}</span></div>
            <div className={styles.balanceRow}><span>Quoted when you review</span><span>{balances.find(item => item.symbol === output) ? `Balance: ${assetAmount(balances.find(item => item.symbol === output)!.amount, output)}` : ""}</span></div>
          </div>
          {token === "ETH" && <p className={styles.routeNote}>Wrap ETH and swap to USDC in one transaction.</p>}
          <details className={styles.settings}>
            <summary><span>Swap settings</span><span>{slippage}% slippage <ChevronDown size={13} aria-hidden="true"/></span></summary>
            <label className={styles.settingField}><span>Slippage tolerance</span><span><input aria-label="Slippage percentage" inputMode="decimal" value={slippage} disabled={busy} onChange={event => setSlippage(event.target.value)}/>%</span></label>
            {!slippageValid && <p role="alert">Choose between 0.01% and 5%, with up to two decimal places.</p>}
            <div className={styles.detailRow}><span>Network</span><span>Ethereum Sepolia</span></div>
            <div className={styles.detailRow}><span>Route</span><span>{token === "ETH" ? "ETH / WETH / USDC" : `${token} / ${output}`}</span></div>
            <p>Test assets. The review shows the quoted output, minimum received and expiry.</p>
          </details>
          {account && <div className={styles.gas}><span>Gas in trading account</span><span>{gasBalance === undefined ? "--" : assetAmount(gasBalance, "ETH")}</span></div>}
          <InlineError message={formError ?? inputIssue}/>
          {balanceError && <p className={styles.warning} role="status">Balances could not refresh. <button type="button" disabled={checking} onClick={() => void checkStatus()}>Try again</button></p>}
          {!balanceError && account && staleBalances && <p className={styles.warning} role="status">Balances last updated {time(w.portfolio.observedAt)}. <button type="button" disabled={checking} onClick={() => void checkStatus()}>Refresh</button></p>}
          {w.resourceErrors.activity && <p className={styles.warning} role="status">Activity could not refresh. <button type="button" disabled={checking} onClick={() => void checkStatus()}>Check status</button></p>}
          {account && !gas.ready && <p className={styles.warning} role="status">Swap execution is temporarily unavailable.</p>}
          {unresolved && <div className={styles.warning} role="status"><span>{unresolved.status === "pending" ? "Your previous swap is confirming." : "Your previous swap needs a status check."}</span><button type="button" disabled={checking} onClick={() => void checkStatus()}>{checking ? "Checking..." : "Check status"}</button></div>}
          {!w.session.user ? <button className={styles.primary} type="button" onClick={() => void w.connect()} disabled={w.connecting}>{w.connecting ? <><Spinner/>Connecting...</> : "Connect wallet"}</button>
            : !account ? <button className={styles.primary} type="button" onClick={onSetup}>Set up trading account</button>
              : <button className={styles.primary} type="submit" disabled={busy || !!unresolved || !amount || !!inputIssue || !slippageValid || !gas.ready}>{w.preparing ? <><Spinner/>Getting quote...</> : w.executing ? "Swap in progress" : "Review swap"}</button>}
        </form>
      </section>
      {account && <section className={styles.account} aria-label="Uniswap trading account">
        <div className={styles.accountHeading}><h2>Your trading account</h2><Address value={account.address} explorer="https://sepolia.etherscan.io"/></div>
        <div className={styles.holdings}>{(["USDC", "WETH", "ETH"] as const).map(symbol => <div key={symbol}><AssetIcon symbol={symbol} size={22}/><span>{symbol}</span><strong>{balances.some(item => item.symbol === symbol) ? assetAmount(balances.find(item => item.symbol === symbol)!.amount, symbol).replace(` ${symbol}`, "") : "--"}</strong></div>)}</div>
        <div className={styles.accountLinks}><button type="button" onClick={onSetup}>Manage account</button><a href="/activity">View activity</a></div>
        {actions.length > 0 && <details className={styles.recent}><summary>Recent swaps <span>{actions.length}</span></summary>{actions.slice(0, 3).map(action => <div key={action.id} className={styles.activity}><div><strong>{action.request.nativeInput ? "ETH" : action.request.side === "buy" ? "USDC" : "WETH"} to {action.request.side === "buy" ? "WETH" : "USDC"}</strong><span>{time(action.createdAt)} / {statusLabel(action.status)}</span></div>{action.transactionHash && <a href={`https://sepolia.etherscan.io/tx/${action.transactionHash}`} target="_blank" rel="noreferrer">Receipt</a>}</div>)}</details>}
      </section>}
    </div>
  </div>;
}
