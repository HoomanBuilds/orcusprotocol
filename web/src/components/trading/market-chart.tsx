"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type UTCTimestamp,
} from "lightweight-charts";
import { CandlestickChart, Maximize2, RefreshCw } from "lucide-react";
import type { MarketCandle, Venue } from "@orcus/core";
import { api, displayError } from "@/lib/api";
import { number } from "@/lib/format";
import { Empty, InlineError } from "./primitives";
import { CHART_THEME } from "./chart-theme";

function movingAverage(values: MarketCandle[], length: number) {
  const output: Array<{ time: UTCTimestamp; value: number }> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i].close;
    if (i >= length) sum -= values[i - length].close;
    if (i >= length - 1)
      output.push({
        time: values[i].time as UTCTimestamp,
        value: sum / length,
      });
  }
  return output;
}

export function MarketChart({
  venue,
  symbol,
}: {
  venue: Venue;
  symbol: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const [interval, setIntervalValue] = useState("15m");
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [showAverage, setShowAverage] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load(initial: boolean) {
      if (initial) {
        setLoading(true);
        setCandles([]);
      }
      try {
        const data = await api<{ candles: MarketCandle[] }>(
          `/api/candles?venue=${venue}&symbol=${encodeURIComponent(symbol)}&interval=${interval}`,
          { signal: controller.signal },
        );
        if (!active) return;
        const unique = new Map(
          (data.candles ?? [])
            .filter((c) =>
              [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite),
            )
            .map((c) => [c.time, c]),
        );
        setCandles([...unique.values()].sort((a, b) => a.time - b.time));
        setError(null);
      } catch (cause) {
        if (active) setError(displayError(cause));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load(true);
    const timer = setInterval(() => {
      void load(false);
    }, 30000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [venue, symbol, interval, refresh]);

  useEffect(() => {
    if (!container.current || !candles.length) return;
    const chart = createChart(container.current, {
      height: container.current.clientHeight || 360,
      layout: {
        background: { type: ColorType.Solid, color: CHART_THEME.panel },
        textColor: CHART_THEME.faint,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: CHART_THEME.grid },
        horzLines: { color: CHART_THEME.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CHART_THEME.crosshair },
        horzLine: { color: CHART_THEME.crosshair },
      },
      rightPriceScale: {
        borderColor: CHART_THEME.border,
        scaleMargins: { top: 0.12, bottom: 0.2 },
      },
      timeScale: {
        borderColor: CHART_THEME.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: CHART_THEME.up,
      downColor: CHART_THEME.down,
      borderVisible: false,
      wickUpColor: CHART_THEME.up,
      wickDownColor: CHART_THEME.down,
    });
    series.setData(
      candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })),
    );
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volume.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume ?? 0,
        color:
          c.close >= c.open ? CHART_THEME.upVolume : CHART_THEME.downVolume,
      })),
    );
    if (showAverage)
      chart
        .addSeries(LineSeries, {
          color: "#d5bf7e",
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
        })
        .setData(movingAverage(candles, 25));
    chart.timeScale().fitContent();
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry)
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [candles, showAverage]);

  const last = candles.at(-1);
  return (
    <section
      className="chart-panel"
      ref={section}
      aria-label={`${symbol} price chart`}
    >
      <div className="chart-toolbar">
        <div className="intervals">
          {["5m", "15m", "1h", "4h", "1d"].map((value) => (
            <button
              key={value}
              type="button"
              className={interval === value ? "selected" : ""}
              onClick={() => setIntervalValue(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="chart-tools">
          <button
            className={showAverage ? "selected" : ""}
            type="button"
            aria-pressed={showAverage}
            onClick={() => setShowAverage((value) => !value)}
          >
            <CandlestickChart size={13} />
            MA 25
          </button>
          <button
            type="button"
            aria-label="Refresh chart"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            aria-label="Expand chart"
            onClick={() => void section.current?.requestFullscreen?.()}
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      <div className="ohlc">
        <span>
          {symbol} / {venue === "uniswap" ? "SPOT" : venue === "ostium" ? "ORACLE REFERENCE" : "PERPETUAL"}
        </span>
        {last && (
          <>
            <span>
              O <b>{number(last.open)}</b>
            </span>
            <span>
              H <b>{number(last.high)}</b>
            </span>
            <span>
              L <b>{number(last.low)}</b>
            </span>
            <span>
              C <b>{number(last.close)}</b>
            </span>
          </>
        )}
      </div>
      <InlineError message={error ? `Chart unavailable: ${error}` : null} />
      <div className="chart-canvas" ref={container} />
      {!candles.length && (
        <div className="chart-placeholder">
          {loading ? (
            <div className="chart-loading">
              <div className="skeleton chart-skeleton" />
              <span>Loading live market candles...</span>
            </div>
          ) : (
            <Empty title="Waiting for market data">
              {venue === "uniswap"
                ? "Spot price history is not configured for this route. Quotes remain the source of execution prices."
                : "No candles were returned for this market. Refresh the feed or choose another instrument."}
            </Empty>
          )}
        </div>
      )}
      <div className="chart-footer">
        <span>
          <i
            className={`dot ${error ? "warn" : candles.length ? "good" : ""}`}
          />
          {error
            ? "Feed unavailable"
            : candles.length
              ? "Venue data"
              : "No price history"}
        </span>
        <span>UTC / {interval} candles</span>
      </div>
    </section>
  );
}
