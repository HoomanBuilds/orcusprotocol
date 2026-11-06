# Ostium testnet authority and venue decision

Research only, verified November 6, 2026. No SDK package was installed or executed, and no transaction, permission grant or funding action was sent during this inspection.

## Current deployed source, not the SDK description

The official TypeScript package is `@ostium/builder-sdk` version `0.12.0`; its registry tarball SHA-512 integrity matched the published registry value. The [overview](https://docs.ostium.com/developer/sdk/overview) still names `0.11.0`. The [setDelegate reference](https://docs.ostium.com/developer/reference/set-delegate) and published SDK build a wrapped delegate-rotation transaction, but that is not evidence that the deployed contract accepts it.

An initial SDK-only research conclusion incorrectly described delegate rotation as confirmed native behavior. Inspection of the current linked testnet implementation disproved it. The current `delegatedAction` explicitly forbids the selectors for `setDelegate`, `setDelegateWithSignature`, `removeDelegate` and nested `delegatedAction`, and rejects a reentrant delegated call. Permission changes therefore require the actual owner on this verified implementation. Do not use the SDK's delegate-wrapped permission helpers or repeat the earlier incorrect conclusion.

## Pinned, unsigned chain observation

Public RPC: `https://sepolia-rollup.arbitrum.io/rpc`; `eth_chainId` returned `421614`. At block `326605267`, read the EIP-1967 implementation slot and registry references:

| Item | Address |
| --- | --- |
| Trading proxy | `0x2A9B9c988393f46a2537B0ff11E98c2C15a95afe` |
| Trading implementation | `0x4Cd56D0cD2708BDED6CCfF04B116B1FF416A5D71` |
| Registry returned by `registry()` | `0xf86cff7679BA3E99d21255d774088E25FE0ec34a` |
| Registry `callbacks` proxy | `0x83DC7c5dDeAD58f47230b70e6EF6bc44064BD814` |
| Callbacks implementation | `0x428e31408ab1d2c6fec67eb7871dd701be1db6fb` |
| Registry `tradingStorage` proxy | `0x0b9F5243B29938668c9Cfbd7557A389EC7Ef88b8` |
| Trading storage implementation | `0xb740b62d6a22ec8fe814ae8c4c46831ff16b2aae` |

The slot is `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`. Registry lookup is `getContractAddress(bytes32)`, with the padded UTF-8 keys `callbacks` and `tradingStorage`, not a string-typed function or the key `tradingCallbacks`.

[Trading verification](https://sourcify.dev/server/v2/contract/421614/0x4cd56d0cd2708bded6ccff04b116b1ff416a5d71) returned match ID `31847218`, runtime match `match`, verified June 9, 2026. Its [verified sources](https://sourcify.dev/server/v2/contract/421614/0x4cd56d0cd2708bded6ccff04b116b1ff416a5d71?fields=compilation,sources) include `src/abstract/Delegatable.sol` and `src/OstiumTrading.sol`.

## Exact authority boundary

- `Delegatable.delegations` maps one owner to one delegate. A new owner-approved registration replaces that entry. Never silently replace an existing different delegate.
- `setDelegate(address)` has no expiry or asset/amount scope. In `setDelegateWithSignature`, `expiry` bounds submission of the signed authorization; it is not the expiration of the resulting delegation. Per-action limits and expiry in Orcus remain application-enforced unless an additional reviewed onchain restriction is deployed.
- `delegatedAction` is restricted to the trading contract itself, not an arbitrary external target. The blocked-selector checks preserve native owner-only grant changes on the inspected implementation.
- `OstiumTrading.openTrade` charges collateral from the effective sender and reconstructs the stored trader from that sender in both market and limit paths. Closing uses that sender's existing trade. The caller cannot choose an arbitrary close-payout recipient.
- Closing payouts are bound to `trade.trader` in `src/lib/TradingCallbacksLib.sol`, lines 686-693 of the [verified callback sources](https://sourcify.dev/server/v2/contract/421614/0x428e31408ab1d2c6fec67eb7871dd701be1db6fb?fields=compilation,sources). Collateral removal pays `request.trader` in `src/OstiumTradingCallbacks.sol`, line 735; the request's trader is the effective sender saved by `OstiumTrading.removeCollateral`.
- A delegate can still request collateral removal and cause trading losses or fees. Opening also accepts a builder recipient and fee, capped in this implementation at 0.5% of notional. Returning principal to the owner is not an arbitrary external withdrawal, but the raw key is broader than a close-only or bounded-budget key. Orcus must independently restrict selectors, the trader, amounts, expiry and builder fee fields before signing, and explain the raw native authority before an owner grants it.

These observations are point-in-time source and chain evidence. An upgrade requires renewed review; do not assume the documented restrictions hold for another implementation or network.

## Actual useful market coverage

The [documented testnet subgraph](https://docs.ostium.com/developer/client-modes/testnet), queried with `chainId=421614`, returned HTTP 200 and 83 pairs. [Public live prices](https://docs.ostium.com/developer/builder-api/get-prices) returned HTTP 200, 94 rows and `stale: false`. The sources serve different purposes: a price alone does not establish testnet execution readiness.

Several testnet pairs, including BTC, ETH, EUR/USD and SPX, reported zero maximum leverage and must not be advertised as accepting new positions. XAU, XAG, CL, USD/JPY and NDX were nonzero candidates at observation. Runtime discovery must also check current market hours, live price freshness, limits, liquidity, USDC allowance/balance and RPC chain identity. Do not freeze this observed catalog into configuration.

## Recommendation and comparison

Ostium is the highest-value next venue because it adds FX, metals, oil and index price exposure instead of duplicating only crypto perpetuals. Implement its supported testnet capabilities using the official SDK, with actual owner-signed workflows and separately explicit native delegation. Default to owner approval; autonomous operation requires the full disclosed native grant and deterministic per-action checks, not a model assertion. Do not describe leveraged price exposure as ownership of stocks, commodities or foreign currency.

GMX remains the next EVM comparison. Its [official SubaccountRouter](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/SubaccountRouter.sol) and [SubaccountUtils](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/subaccount/SubaccountUtils.sol) implement owner-managed subaccounts, native action counts/expiry and receiver restrictions. Those are not per-market or per-dollar caps. Its [SDK v2](https://docs.gmx.io/docs/sdk/v2/) documents Arbitrum Sepolia, but relay/API/testnet deployment readiness still needs a separate check. These strengths do not eliminate that integration work or justify replacing Ostium's distinct asset coverage.
