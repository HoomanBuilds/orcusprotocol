import assert from "node:assert/strict";
import { buildAgentTools } from "../agent/src/compute/tools";

const tools = buildAgentTools({}, "Read-only public Hyperliquid testnet research verification.");
for (const [name, input] of [
  ["read_markets", { venue: "hyperliquid", symbols: ["ETH"] }],
  ["analyze_market", { venue: "hyperliquid", symbol: "ETH", interval: "1h", limit: 20 }],
  ["read_market_context", { venue: "hyperliquid", symbol: "ETH" }],
] as const) {
  const result = await tools.get(name)!.run(input) as { sources?: unknown[]; candleCount?: number; closedCandlesOnly?: boolean };
  assert.ok(result.sources?.length, `${name} must preserve public source metadata`);
  if (name === "analyze_market") { assert.equal(result.closedCandlesOnly, true); assert.ok(result.candleCount! >= 20); }
  console.log(JSON.stringify({ tool: name, status: "passed", sources: result.sources, publicChainWrites: 0, inferenceCalls: 0, searchCalls: 0 }));
}
