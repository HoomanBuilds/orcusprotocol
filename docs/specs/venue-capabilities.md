# Trading venue capabilities

Updated: 2026-11-06. Reviewed source baseline: `c21352b`.

This is a product reference, not runtime configuration. Markets, prices, limits and authorizations are discovered and checked at execution time. A logo, API method or read-only listing is not proof that an instrument can be traded.

## Status and evidence

| Venue | Implemented scope | Acceptance still separate |
| --- | --- | --- |
| Uniswap | Ethereum Sepolia V3 spot quotes, bounded owner/session swaps and settlement verification | Public operator-paymaster deployment/funding, canonical bundler admission and installed-wallet acceptance |
| Hyperliquid | Testnet perpetual market/limit orders, protective orders, reduction/close/cancellation, native agent authorization and lifecycle recovery | Broader account-mode/extension acceptance; capabilities not implemented below must not appear enabled |
| Ostium | Arbitrum Sepolia discovery, data/history, SDK-native entry/management, owner/delegate signing, durable reconciliation and venue-bound CRE evaluation | Integrated terminal/account controls and final browser review are pending at this baseline; public funding, delegation and trade acceptance have not been run |

Uniswap owner/session swaps and platform-paid gas have isolated-fork evidence. Hyperliquid has one approved capped public testnet same-account handoff that ended flat with the fresh agent revoked. Ostium has source/deployment verification, unsigned reads, focused SDK/core/server regressions and an actual managed CRE read-only alert, not public trade evidence. Focused checks are not a formal security audit or a guarantee of ongoing provider availability. See the [verification record](../research/verification-2026-11-06.md) and [Ostium authority evidence](../research/ostium-authority-2026-11-06.md).

## Shared control and revocation

Manual and agent actions address the same venue account, not separate portfolios. Connection/login does not authorize trading. Pause/Take Over stops future queued work and invalidates stale plans, but cannot unsend every in-flight action. Local expiry, key rotation or a disabled automation is not proof of native revocation.

Owner revocation is venue-specific: Kernel permission recovery/revocation has code and regression coverage but external sponsored acceptance remains gated; Hyperliquid fresh-agent revocation was live-testnet verified; Ostium's owner-only `removeDelegate` builder and fresh native-authority checks are implemented but public revocation acceptance is pending. Preserve previous signer addresses for recovery and never revoke an unrelated delegate.

## Uniswap

| Capability | Actual behavior | Boundary |
| --- | --- | --- |
| Markets and account state | Verified Sepolia WETH/USDC route; ETH, WETH and USDC balances | Not every token/chain shown elsewhere is a supported swap route. Testnet pool prices are not mainnet valuations |
| Order entry | Exact-input swap in either WETH/USDC direction; reviewed fee tier, expected/minimum output, bounded approvals and router deadline | No exact-output, multihop, solver limit-order or liquidity-position workflow is implemented |
| Native ETH | Explicit ETH input atomically wraps the exact amount in the smart-account batch before swapping into USDC | Buying returns WETH, not native ETH. Native output/unwrapping and bridges are disabled |
| Owner signing | Owner controls the funded Kernel account; owner-only EOA swaps are also distinguished | Wallet connection moves no funds and grants no agent authority |
| Agent signing | Separately approved Kernel permission/session signer; decoded calls bind tokens, router, recipient, amount bands and expiry | ERC-4337 alone does not enforce these limits. Fixed minimum-output bands can reject a smaller input even below the USD cap |
| Funding and gas | Explicit same-chain owner deposit; platform operator paymaster is the primary smart-account gas path | External owner deposits need Sepolia ETH. Unavailable sponsorship never silently charges the user or switches providers |
| History and settlement | Orcus action evidence, exact input/output transfers and the matching account user operation | Not a full historical wallet indexer. Submission or receipt existence alone is not a verified successful swap |

Amounts use the actual input token's decimals; output has its own verified precision. Selling a spot balance does not close a perpetual position. Swaps have no resting order to cancel after execution; uncertain submissions are reconciled, not replayed.

Implementation: [V3 adapter](../../agent/src/venues/uniswap/index.ts), [Kernel permissions](../../packages/wallets/src/kernel.ts), [owner/session execution](../../packages/wallets/src/execution.ts), [operator sponsorship](../../packages/server/src/operator-sponsor.ts). Protocol reference: [official single-hop swap guide](https://developers.uniswap.org/docs/protocols/v3/guides/swapping/single-hop-swapping).

## Hyperliquid

| Capability | Actual behavior | Boundary |
| --- | --- | --- |
| Markets and context | Current non-delisted testnet perpetual metadata, candles, real depth, hourly funding and open interest | Source timestamps and stale/unavailable states remain visible. Depth is not fabricated for another venue |
| Account state | Trading-address equity/collateral observation, positions, open orders, P&L and liquidation information | Read the owner/trading account, not the agent signer's address. Collateral remains venue-specific |
| Order entry | Slippage-bounded IOC market execution and GTC limit orders with native size/price precision | No post-only, TWAP, stop-entry, amend-order or isolated-margin adjustment workflow is implemented |
| Position management | Fresh-position full close/reduction and reduce-only market-trigger SL/TP; cancel an exact open order | Reduction cannot exceed the current position. Changing leverage is not implemented; the order uses the account's current venue leverage |
| Owner/agent control | Owner signs manual actions; an explicitly approved native agent key trades the same account and can manage positions opened elsewhere | Native agent authorization does not enforce every Orcus per-symbol/per-trade cap. Application expiry/limits must not be presented as independent native restrictions |
| Funding and fees | Existing funded testnet venue account; venue fees apply to orders | No new deposit, withdrawal or bridge flow is implemented here. HTTP order signing does not use the Uniswap paymaster |
| History and recovery | Client/venue order IDs, remaining/original size, partial fills and order-correlated fee evidence | Retained/malformed/truncated fill history cannot prove complete execution. A cancellation can race an actual fill |

Order amounts are base-asset quantity, not USDC collateral. The adapter explicitly rejects other venues and unsupported action types before external reads; schema validation independently rejects Ostium-only fields. Acknowledged/resting/partially filled/filled/cancelled/rejected/unknown outcomes are not interchangeable.

Implementation: [venue adapter](../../agent/src/venues/hyperliquid/index.ts), [lifecycle/fill evidence](../../agent/src/venues/hyperliquid/lifecycle.ts), [public market-context reader](../../web/src/lib/server/market-context.ts). Protocol references: [Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), [Exchange API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint), [native API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets), [funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding).

## Ostium

Uses the pinned official `@ostium/builder-sdk@0.12.0` on Arbitrum Sepolia. FX, commodity, index and equity-linked instruments provide leveraged price exposure, not ownership of foreign currency, physical assets or shares.

| Capability | Actual behavior | Boundary |
| --- | --- | --- |
| Discovery and data | Current pairs, live prices, candles, open/closed status, leverage/day-trade limits, typed fees, rollover and schedules | A price feed alone does not prove a testnet pair accepts new positions. Zero maximum leverage, stale price or closed market blocks opening |
| Account/history | Owner EOA USDC/ETH balances, positions, resting and oracle-pending orders, fills/orders/limit-order history | Position PID differs from reusable index/slot. Loaded histories are bounded and are not a claim of a complete lifetime export |
| Entry modes | SDK-native market, limit and stop entry; explicit collateral, leverage, slippage and optional TP/SL | Current preview must approve exposure/fees. No arbitrary spot token, native-input swap or cross-chain route |
| Position controls | Close/reduce, set/change/clear SL/TP, add collateral; remove collateral requires the owner in Orcus | Exit uses current PID/index/size. Partial close is rounded down and must satisfy the SDK's minimum supported percentage |
| Order controls | Edit resting entry price and reviewed protections; cancel an exact resting order; supported pending-open/pending-close timeout cancellation | Zero amount is allowed only for Ostium cancellation with an exact nonempty order ID and explicit base units. Other amounts remain positive. Timeout recovery has no automatic retry; a reused limit slot is not evidence for the original order |
| Owner signing | Owner browser wallet signs each exact approval and native call; deployment and chain identity checked | Approvals and trade are separate transactions, not an atomic batch. The owner key is never given to the server |
| Agent signing | Explicit owner-set native delegate plus separately reviewed Orcus caps/expiry, fresh authority and calldata checks | One native delegate per owner. Never silently replace a different delegate. Native grant has no onchain asset/notional cap or grant expiry |
| Funding/gas | Existing owner EOA holds Ostium's testnet USDC; exact USDC allowance can be owner-approved | Owner pays Arbitrum Sepolia ETH for manual calls; agent EOA pays its own Arbitrum Sepolia ETH for agent calls. The Uniswap Sepolia paymaster does not cover either |
| Recovery | Durable pre-wallet intent, separate approval/trade hashes, minimum-block/account/calldata binding, globally deduplicated proofs and indexed lifecycle evidence | Missing receipt, oracle result, indexer evidence or wallet hash remains pending/unknown. No automatic repeat signature or broadcast |
| Conditional automation | Native pair/feed identity, exact quote-currency thresholds, Arbitrum Sepolia block-bound USDC reads and typed candidate checks; actual managed read-only alert passed | No guessed Coinbase symbols for global instruments. Collateral removal remains owner-only. An alert allow means notify, not trade authorization; combined 0G-to-native-trade and hosted DON proof remain separate |

Opening and collateral changes use explicit `collateral-usdc`; position exits use `base`. Collateral and notional are separately previewed and capped. USDC has six decimals; fractional leverage has its own precision. Fee/rate units remain explicit: open fee in basis points, oracle fee in USDC, signed rollover rate for the documented eight-hour interval.

CRE obtains the current pair and feed through live sources using the official SDK's canonical aliases, not a frozen market catalog. Native prices and thresholds use exact E18 values in the pair's quote currency: `USD/JPY` is JPY-quoted, not a USD valuation. Entry/add-collateral checks use actual USDC debit; exits check oracle fees rather than treating base quantity as collateral. The managed result parser reconstructs bounded ordered frames and validates account, evaluation, policy, revision and expiry before accepting a result.

The verified native implementation blocks a delegate from granting/revoking/rotating delegation, and payouts stay bound to the trader. However, the raw native key can request collateral removal and cause losses or builder fees. Orcus blocks agent collateral removal and fixes builder recipient/fee to zero; those extra safeguards are application controls. The owner must acknowledge this difference before granting access. A signature-submission expiry is not native grant expiry.

Quote expiry is checked locally before signing/broadcast. The native Ostium call does not carry an onchain transaction deadline. A successful initiating receipt is not a filled market/limit order: settlement additionally needs matching oracle/indexed execution evidence. Confirmed protection edits are labelled native-control success, not trade fills.

Implementation: [data/history](../../agent/src/venues/ostium/data.ts), [SDK builders and submission](../../agent/src/venues/ostium/execution.ts), [native settlement](../../agent/src/venues/ostium/reconciliation.ts), [owner/calldata inspection](../../packages/wallets/src/ostium.ts), [browser signing](../../packages/wallets/src/ostium-owner.ts), [server authority/risk checks](../../packages/server/src/ostium-policy.ts), [allowance recovery](../../packages/server/src/ostium-allowances.ts), [CRE native observations](../../workflows/cre/strategy/ostium.ts), [managed runner/result validation](../../agent/src/automation/cre.ts). Protocol references: [testnet mode](https://docs.ostium.com/developer/client-modes/testnet), [SDK overview](https://docs.ostium.com/developer/sdk/overview), [delegate reference](https://docs.ostium.com/developer/reference/set-delegate). Deployed-source authority takes precedence over incompatible SDK examples; exact review evidence and upgrade assumptions are in the [authority record](../research/ostium-authority-2026-11-06.md).

## Evaluated, not integrated

| Candidate | Capability worth evaluating | Current product status |
| --- | --- | --- |
| [GMX](https://docs.gmx.io/docs/sdk/v2/) | Additional EVM perpetual execution and subaccount model | No adapter, UI, funding or settlement acceptance. Verified native action-count/expiry restrictions are not per-market/dollar caps |
| [Derive](https://docs.derive.xyz/) | Options and another perpetual venue | No adapter or accepted session-key implementation; do not advertise options trading as available |
| [CoW Protocol](https://docs.cow.fi/cow-protocol/integrate/api) | Solver-based spot and signed orders | No execution adapter or verified Orcus contract-wallet signing path |
| [gTrade](https://docs.gains.trade/developer/trading-api/overview) | Another global-market leveraged venue | Shortlisted alternative, not implemented or a substitute for Ostium's native permissions |
| [Lighter](https://docs.lighter.xyz/api), [Orderly](https://orderly.network/docs/build-on-omnichain/introduction), [dYdX](https://docs.dydx.xyz/interaction/endpoints) | Further perpetual/orderbook venues | Shortlisted only. Endpoint reachability is not funded accounts, safe delegation or working fills |
| [Jupiter](https://developers.jup.ag/docs/get-started/development-basics) | Solana spot access | Not integrated. A separate Solana account/authorization design and current deployment verification are required |

Adding a venue does not make collateral universal or move a position between protocols. New adapters must cover their relevant entry, management, authorization, funding and recovery workflow before being called supported. Sponsors remain 0G, Uniswap and Chainlink CRE; these candidates do not change that selection.
