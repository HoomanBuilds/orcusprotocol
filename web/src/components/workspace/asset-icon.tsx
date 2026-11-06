import { Coins } from "lucide-react";
import type { Venue } from "@orcus/core";

const assetFiles: Record<string, string> = Object.fromEntries(["ETH", "USDC", "BTC", "SOL", "XRP", "DOGE", "AVAX", "LINK", "BNB", "ADA", "DOT"].map(symbol => [symbol, `/landing/tokens/${symbol}.svg`]));
assetFiles.WETH = "/landing/tokens/WETH.png";
assetFiles.HYPE = "/landing/brands/hyperliquid.svg";

export function hasAssetIcon(symbol: string) {
  return Boolean(assetFiles[symbol.split("/")[0].toUpperCase()]);
}

export function AssetIcon({ symbol, size = 32 }: { symbol: string; size?: number }) {
  const name = symbol.split("/")[0].toUpperCase();
  const source = assetFiles[name];
  return <span className={`workspace-asset-icon ${name === "HYPE" ? "hyperliquid" : ""}`} style={{ width: size, height: size }} title={source ? name : `${name} logo unavailable`}>
    {source ? <img src={source} alt="" width={size} height={size} decoding="async"/> : <Coins size={Math.round(size * .55)} aria-hidden="true"/>}
  </span>;
}

export function ProtocolIcon({ name, size = 28 }: { name: Venue | "0g" | "chainlink"; size?: number }) {
  return <span className={`workspace-protocol-icon ${name}`} style={{ width: size, height: size }}><img src={`/landing/brands/${name}.svg`} alt="" width={size} height={size} decoding="async"/></span>;
}
