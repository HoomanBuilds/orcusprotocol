import type { TradingAccount } from "@orcus/core";
import { Address } from "./primitives";

export function WalletRoles({ owner, account, operatingAddress }: { owner?: string; account?: TradingAccount; operatingAddress?: string }) {
  if (!owner) return null;
  return <section className="info-banner" aria-label="Wallet roles">
    <div><strong>Owner wallet</strong><br /><Address value={owner} /><small>Signs access and keeps ownership.</small></div>
    <div><strong>{account?.venue === "hyperliquid" ? "Hyperliquid trading account" : "Smart trading account"}</strong><br /><Address value={account?.address} explorer={account?.venue === "uniswap" ? "https://sepolia.etherscan.io" : undefined} /><small>Trading principal and shared positions.</small></div>
    <div><strong>Agent operating wallet</strong><br /><Address value={operatingAddress} explorer="https://chainscan-galileo.0g.ai" /><small>Separate service costs, never trading principal.</small></div>
  </section>;
}
