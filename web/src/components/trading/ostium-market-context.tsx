import type { Market } from "@orcus/core";
import { assetAmount, quotePrice, usd } from "@/lib/format";
import { ProtocolIcon } from "../workspace/asset-icon";

function rate(value?: string) {
  if (value === undefined || value === "" || !Number.isFinite(Number(value))) return "Unavailable";
  const parsed = Number(value);
  return `${parsed > 0 ? "+" : ""}${parsed.toLocaleString("en-US", { maximumFractionDigits: 8 })}%`;
}

export function OstiumMarketContext({ market, symbol }: { market?: Market; symbol: string }) {
  const [base, quote = "USD"] = symbol.split("/");
  return <section className="native-market-context" aria-label="Ostium market context"><header><ProtocolIcon name="ostium" size={22}/><h2>Market details</h2></header><div className="native-market-state"><span className={`dot ${market?.tradable ? "good" : "warn"}`}/>{market?.tradable ? "Open for entries" : market?.unavailableReason ?? "Current market data unavailable"}</div><dl><div><dt>Reference price</dt><dd>{quotePrice(market?.midPrice, quote)}</dd></div><div><dt>Price unit</dt><dd>{quote} per {base}</dd></div><div><dt>Category</dt><dd>{market?.category ?? "Unavailable"}</dd></div><div><dt>Leverage range</dt><dd>{market?.minLeverage !== undefined && market.maxLeverage !== undefined ? `${market.minLeverage}x - ${market.maxLeverage}x` : "Unavailable"}</dd></div><div><dt>Overnight maximum</dt><dd>{market?.overnightMaxLeverage !== undefined ? `${market.overnightMaxLeverage}x` : "Unavailable"}</dd></div><div><dt>Open interest (USD)</dt><dd>{usd(market?.openInterest)}</dd></div></dl><details><summary>Fees &amp; rollover</summary><dl><div><dt>Opening fee</dt><dd>{market?.openFeeBps === undefined ? "Unavailable" : `${market.openFeeBps} bps`}</dd></div><div><dt>Oracle fee</dt><dd>{assetAmount(market?.oracleFeeUsdc, "USDC")}</dd></div><div><dt>Long rollover / 8h</dt><dd>{rate(market?.rolloverRate?.long)}</dd></div><div><dt>Short rollover / 8h</dt><dd>{rate(market?.rolloverRate?.short)}</dd></div></dl><p>Rollover is a signed eight-hour percentage. Positive pays; negative earns. Current rates can change.</p></details><details><summary>Market hours</summary>{market?.schedule ? <><p>{market.schedule.alwaysOpen ? "Always-open schedule" : market.schedule.timezone ?? "Schedule timezone unavailable"}</p>{market.schedule.openingHours?.map((hours, index) => <p key={index}>{hours}</p>)}</> : <p>No schedule was supplied. The current open/closed venue observation controls entry availability.</p>}</details><p className="native-market-boundary">Leveraged price exposure, settled in USDC. Native oracle execution; no resting order book is shown.</p></section>;
}
