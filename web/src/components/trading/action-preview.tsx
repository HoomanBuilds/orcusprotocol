"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Clock3, ShieldCheck, X } from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { number, shortAddress } from "@/lib/format";
import { InlineError, Spinner } from "./primitives";

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
  const [baseAsset, quoteAsset = "USDC"] = request.symbol.split("/");
  const inputAsset =
    request.venue === "uniswap" && request.side === "buy"
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
          <span className="eyebrow">REVIEW BEFORE SIGNING</span>
          <h2>
            {request.type === "swap"
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
          {number(request.amount, 6)} <span>{inputAsset}</span>
        </b>
        <span>
          {request.side.toUpperCase()} <ArrowRight size={14} />{" "}
          {request.venue === "uniswap" ? "Uniswap" : "Hyperliquid"}
        </span>
      </div>
      <dl className="preview-details">
        <div>
          <dt>Account</dt>
          <dd title={prepared.account.address}>
            {shortAddress(prepared.account.address)}
          </dd>
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
        <div>
          <dt>Quote expires</dt>
          <dd className={expiresIn ? "" : "negative"}>
            <Clock3 size={12} />
            {expiresIn ? `${expiresIn}s` : "Expired"}
          </dd>
        </div>
      </dl>
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
          disabled={w.executing || !expiresIn}
          onClick={() => void w.confirm()}
        >
          {w.executing ? (
            <>
              <Spinner />
              {prepared.request.mode === "agent" ? "Executing with agent" : "Confirming in wallet"}
            </>
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
