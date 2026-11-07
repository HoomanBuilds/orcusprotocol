"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Market, Venue } from "@orcus/core";
import { api } from "../../lib/api";
import styles from "./venue-symbol-picker.module.css";

export function selectedVenueSymbols(value: string) {
  return [...new Set(value.split(",").map(symbol => symbol.trim()).filter(Boolean))];
}

export function toggleVenueSymbol(value: string, symbol: string) {
  const selected = selectedVenueSymbols(value);
  return (selected.includes(symbol) ? selected.filter(item => item !== symbol) : selected.length < 30 ? [...selected, symbol] : selected).join(", ");
}

export function filterVenueSymbols(markets: Market[], venue: Venue, search: string) {
  const query = search.trim().toLowerCase();
  return markets.filter((market, index, all) => market.venue === venue && all.findIndex(item => item.venue === venue && item.symbol === market.symbol) === index &&
    `${market.symbol} ${market.baseAsset} ${market.quoteAsset}`.toLowerCase().includes(query));
}

export function VenueSymbolPicker({ venue, value, onChange, disabled = false }: {
  venue: Venue; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const [catalog, setCatalog] = useState<{ venue: Venue; markets: Market[] } | null>(null);
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const id = useId();
  const selected = selectedVenueSymbols(value);
  const markets = catalog?.venue === venue ? catalog.markets : null;

  useEffect(() => {
    setOpen(false); setSearch(""); setCatalog(null); setFailed(false);
  }, [venue]);

  useEffect(() => {
    if (!open || markets) return;
    const controller = new AbortController();
    setFailed(false);
    void api<{ markets: Market[] }>(`/api/markets?venue=${encodeURIComponent(venue)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setCatalog({ venue, markets: result.markets }); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [venue, open, attempt, markets]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const closeOutside = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function toggle(symbol: string) {
    if (disabled) return;
    onChange(toggleVenueSymbol(value, symbol));
  }

  const matches = filterVenueSymbols(markets ?? [], venue, search);
  return <div className={styles.picker} ref={wrapper} onKeyDown={event => {
    if (event.key === "Escape") { setOpen(false); wrapper.current?.querySelector<HTMLButtonElement>("[aria-expanded]")?.focus(); }
  }}>
    <span className={styles.label} id={`${id}-label`}>Allowed assets</span>
    <button type="button" className={styles.trigger} aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open && !disabled} aria-controls={`${id}-options`} disabled={disabled} onClick={() => setOpen(current => !current)}>
      <span id={`${id}-value`}>{selected.length ? `${selected.length} selected` : "Select assets"}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    {selected.length > 0 && <div className={styles.chips}>{selected.map(symbol => <button key={symbol} className={styles.chip} type="button" disabled={disabled} onClick={() => toggle(symbol)} aria-label={`Remove ${symbol}`}><span>{symbol}</span><span aria-hidden="true">×</span></button>)}</div>}
    {open && !disabled && <div className={styles.dropdown} id={`${id}-options`}>
      <input ref={input} className={styles.search} aria-label="Search assets" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search assets" autoComplete="off"/>
      <div className={styles.options} role="group" aria-label="Available assets">
        {!markets && !failed && <p role="status">Loading assets...</p>}
        {failed && <div role="alert"><p>Could not load assets.</p><button type="button" className="text-link" onClick={() => setAttempt(current => current + 1)}>Try again</button></div>}
        {markets && !matches.length && <p role="status">{search ? "No matching assets." : "No assets available."}</p>}
        {matches.map(market => <label key={market.symbol} className={styles.option}>
          <input type="checkbox" checked={selected.includes(market.symbol)} disabled={!selected.includes(market.symbol) && selected.length >= 30} onChange={() => toggle(market.symbol)}/>
          <span>{market.symbol}</span>
          {market.marketOpen === false ? <small>Market closed</small> : market.tradable === false ? <small>Trading unavailable</small> : null}
        </label>)}
      </div>
      <div className={styles.footer}><span>{selected.length}/30 selected</span><button type="button" className="text-link" onClick={() => setOpen(false)}>Done</button></div>
    </div>}
  </div>;
}
