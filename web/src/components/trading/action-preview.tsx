"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Clock3, ShieldCheck, X } from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { assetAmount, number, tokenUnits } from "@/lib/format";
import { actionReviewLabel, hasAtomicNativeInput, tradingGasStatus } from "@/lib/trade-ux";
import { Address, InlineError, Spinner } from "./primitives";
import { OstiumReviewDetails } from "./ostium-review-details";
import { venuePresentation } from "@/lib/venue-presentation";

export function ActionPreview({ workspace: w }: { workspace: Workspace }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (w.preview) dialog.current?.showModal();
    else dialog.current?.close();
  }, [w.preview]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!w.preview) return null;
  const prepared = w.preview.execution;
  const request = prepared.request;
  const actionLabel = actionReviewLabel(request);
  const gas = tradingGasStatus(w.walletConfig, request.venue);
  const atomicNative = hasAtomicNativeInput(prepared);
  const invalidNative = !!request.nativeInput && !atomicNative;
  const [baseAsset, quoteAsset = "USDC"] = request.symbol.split("/");
  const inputAsset =
    request.venue === "ostium" && request.amountUnit === "collateral-usdc" ? "USDC" : atomicNative ? "ETH" : request.venue === "uniswap" && request.side === "buy"
      ? quoteAsset
      : baseAsset;
  const outputAsset = request.side === "buy" ? baseAsset : quoteAsset;
  const expiresIn = Math.max(0, Math.ceil((prepared.expiresAt - now) / 1000));
  return (
    <dialog
      ref={dialog}
      className="action-dialog"
      onCancel={(event) => {
        if (w.executing) event.preventDefault();
        else w.setPreview(null);
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">REVIEW BEFORE EXECUTION</span>
          <h2>
            {!["market", "limit", "stop", "swap"].includes(request.type) ? actionLabel : request.type === "swap"
              ? "Confirm your swap"
              : "Confirm your order"}
          </h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close confirmation"
          disabled={w.executing}
          onClick={() => w.setPreview(null)}
        >
          <X size={18} />
        </button>
      </div>
      <div className="preview-amount">
        <b>
          {request.type === "cancel" ? "Cancel order" : assetAmount(request.amount, inputAsset)}
        </b>
        <span>
          {actionLabel} <ArrowRight size={14} />{" "}
          {venuePresentation[request.venue].name}
        </span>
      </div>
      <dl className="preview-details">
        <div>
          <dt>Trading account</dt>
          <dd><Address value={prepared.account.address} explorer={venuePresentation[request.venue].explorer} /></dd>
        </div>
        <div>
          <dt>Owner wallet</dt>
          <dd><Address value={prepared.account.ownerAddress} /></dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{venuePresentation[request.venue].network}</dd>
        </div>
        <div>
          <dt>Action</dt>
          <dd>
            {request.type}
            {request.reduceOnly ? " / reduce only" : ""}
          </dd>
        </div>
        <div>
          <dt>Slippage cap</dt>
          <dd>{request.slippageBps / 100}%</dd>
        </div>
        {prepared.quote && (
          <>
            <div>
              <dt>Quoted output</dt>
              <dd>
                {number(prepared.quote.amountOut, 6)} {outputAsset}
              </dd>
            </div>
            <div>
              <dt>Minimum output</dt>
              <dd>
                {number(prepared.quote.minimumOut, 6)} {outputAsset}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>Permission</dt>
          <dd>{prepared.request.mode === "agent" ? "Existing scoped agent grant" : "Owner wallet signature"}</dd>
        </div>
        <div><dt>Trading gas / fees</dt><dd>{gas.label}</dd></div>
        <div>
          <dt>Quote expires</dt>
          <dd className={expiresIn ? "" : "negative"}>
            <Clock3 size={12} />
            {expiresIn ? `${expiresIn}s` : "Expired"}
          </dd>
        </div>
      </dl>
      {prepared.ostium && <OstiumReviewDetails prepared={prepared}/>}
      {atomicNative && <p className="fine-print">Wrap exactly {number(request.amount, 6)} native Sepolia ETH, then swap WETH for USDC in one atomic operation. If the operation reverts, neither step completes.</p>}
      {invalidNative && <p className="warning-note">The native ETH wrapping plan could not be verified. Prepare a new supported smart-account quote; this action cannot be submitted.</p>}
      {request.venue === "uniswap" && request.side === "buy" && <p className="fine-print">Output is WETH. Native ETH output and automatic unwrapping are not included.</p>}
      {request.venue === "uniswap" && <p className={gas.ready ? "fine-print" : "warning-note"}>{gas.detail}{w.walletConfig?.gasSponsorship?.maxOperationGasWei ? ` Maximum sponsored network fee: ${tokenUnits(w.walletConfig.gasSponsorship.maxOperationGasWei, 18, "ETH")}.` : ""}{w.walletConfig?.gasSponsorship?.dailyUserGasWei ? ` Daily platform gas allowance cap: ${tokenUnits(w.walletConfig.gasSponsorship.dailyUserGasWei, 18, "ETH")} (not a remaining balance).` : ""} Sponsorship does not supply the tokens you trade.</p>}
      {prepared.warnings?.map((warning) => (
        <p className="warning-note" key={warning}>
          {warning}
        </p>
      ))}
      <div className="safe-note">
        <ShieldCheck size={16} />
        <span>
          {prepared.request.mode === "agent" ? "The agent can execute only within your existing grant. Current permissions are checked again before signing." : "Connecting your wallet does not authorize your agent. This signature is for the action shown above."}
        </span>
      </div>
      <InlineError message={w.error} />
      <div className="dialog-footer">
        <button
          type="button"
          className="button secondary"
          disabled={w.executing}
          onClick={() => w.setPreview(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={w.executing || !expiresIn || !gas.ready || invalidNative}
          onClick={() => void w.confirm()}
        >
          {w.executing ? (
            <>
              <Spinner />
              {prepared.request.mode === "agent" ? "Executing with agent" : "Confirming in wallet"}
            </>
          ) : invalidNative ? (
            "Native input plan unavailable"
          ) : !gas.ready ? (
            "Gas sponsorship unavailable"
          ) : !expiresIn ? (
            "Quote expired"
          ) : (
            prepared.request.mode === "agent" ? "Execute with agent" : "Sign and execute"
          )}
        </button>
      </div>
    </dialog>
  );
}
