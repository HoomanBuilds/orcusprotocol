# Trading context additions

Verified November 6, 2026. This is research and integration evidence, not runtime configuration. The separately mentioned recommendation text was not supplied, so no unprovided recommendations are attributed or approved here.

## Decision

Improve the two existing trading venues before adding a third execution surface. Display real Hyperliquid testnet order-book depth, current hourly funding and open interest. For Uniswap, show the actual reviewed quote's exact input, expected/minimum output, pool fee tier, slippage cap and expiry. Do not add a token, bridge, lending position or new delegated authority for these improvements.

The product benefit is concrete: users can inspect liquidity and carrying costs before a perpetual order, and understand the bounds of a spot swap. These are read-only additions, not stronger trade privacy, fill guarantees or proof that all listed markets can be traded.

## Official verification

- [Hyperliquid Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint): `l2Book` supplies at most 20 levels on each side with price, base-asset size, order count and exchange timestamp. The interface shows up to eight actual levels per side with cumulative base size. It never generates missing levels.
- [Perpetual asset contexts](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals): `metaAndAssetCtxs` maps current asset metadata to mark/oracle price, funding and open interest. Only current, non-delisted markets from this metadata are accepted.
- [Hyperliquid funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding): funding settles hourly between position holders. Positive funding means longs pay shorts; negative means shorts pay longs. The displayed current rate can change before settlement. No annualized yield or guaranteed personal payment is calculated.
- [Uniswap V3 single-hop swaps](https://developers.uniswap.org/docs/protocols/v3/guides/swapping/single-hop-swapping): exact-input swaps use a selected pool fee, protected output and transaction deadline. The existing implementation uses the verified Sepolia route and QuoterV2 result; this change displays that existing result rather than synthesizing an order book or changing the router. Network gas is separate from the pool fee. Sepolia pool prices are not mainnet valuations.

Two unsigned requests against the fixed Hyperliquid testnet Info endpoint returned HTTP 200 during verification: metadata listed 213 assets and the BTC book returned 20 bids and 20 asks with a real exchange timestamp. The sampled BTC context included funding and open interest. This is point-in-time read evidence, not an ongoing availability or execution claim. No private account, paid service, transaction or permission grant was involved.

## Implementation boundaries

The public read endpoint fixes its upstream to Hyperliquid testnet, validates symbols against live metadata, rejects client-selected URLs and caps upstream body size/time. Process-local metadata/book caches, singleflight, a maximum eight distinct concurrent reads and a 24-starts-per-ten-seconds ceiling bound repeated requests. This is not a distributed rate-limit guarantee. Missing or malformed sections are labelled unavailable; stale exchange times are preserved rather than replaced with fetch time. The frontend pauses polling in hidden tabs and discards responses after venue/symbol changes.

The existing terminals supplied cumulative-depth bars, aligned numeric columns and truthful empty/stale-state presentation patterns. Their package-specific order semantics and generated fixture feeds were not imported. Existing wallet authority, execution, payment and settlement paths remain unchanged.

## Focused verification

All 42 tests in the new reader, route, formatting and static-panel suites passed. Web typecheck also passed. Both commands ran serially in one systemd scope capped at 4 GiB with a 2.5 GiB Node heap. Tests cover symbol/network binding, oversized/malformed responses, partial data, stale exchange timestamps, cache/singleflight bounds, request throttling, hourly funding direction, zero versus unavailable, unrelated/expired quotes and passive rendering. They do not submit a trade. Integrated desktop/mobile browser review belongs to the routed workspace acceptance pass; no production build or visual acceptance is claimed by this slice.
