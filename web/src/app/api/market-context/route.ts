import { createMarketContextReader, MarketContextError } from "../../../lib/server/market-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const readMarketContext = createMarketContextReader();
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  if (query.getAll("venue").length !== 1 || query.get("venue") !== "hyperliquid" || query.getAll("symbol").length !== 1 || [...query.keys()].some(key => key !== "venue" && key !== "symbol")) {
    return Response.json({ error: { code: "INVALID_MARKET_QUERY", message: "Choose a Hyperliquid testnet market." } }, { status: 400, headers });
  }
  try { return Response.json({ data: await readMarketContext(query.get("symbol")!) }, { headers }); }
  catch (error) {
    if (error instanceof MarketContextError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
    return Response.json({ error: { code: "MARKET_DATA_UNAVAILABLE", message: "Market data is unavailable. Refresh in a moment." } }, { status: 503, headers });
  }
}
