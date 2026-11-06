import type { Venue } from "@orcus/core";

export const venuePresentation: Record<Venue, { name: string; network: string; marketType: string; explorer?: string }> = {
  uniswap: { name: "Uniswap", network: "Ethereum Sepolia", marketType: "Spot swap", explorer: "https://sepolia.etherscan.io" },
  hyperliquid: { name: "Hyperliquid", network: "Hyperliquid testnet", marketType: "Perpetual" },
  ostium: { name: "Ostium", network: "Arbitrum Sepolia", marketType: "Leveraged exposure", explorer: "https://sepolia.arbiscan.io" },
};

export function venueName(venue: Venue) { return venuePresentation[venue].name; }
export function venueNetwork(venue: Venue) { return venuePresentation[venue].network; }
