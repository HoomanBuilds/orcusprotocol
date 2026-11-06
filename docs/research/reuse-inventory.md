# Source Reuse Inventory

Inspected: 2026-11-05

This is reference material for the [implementation plan](../plans/implementation-plan.md), not runtime configuration. Source paths identify code to inspect and port selectively. They must not become dependencies on a developer's local checkout, production UI content or hard-coded configuration.

Inspection confirms code exists and identifies adaptations. It does not establish that a feature works end to end in this new repository.

## Source snapshots and ownership

| Source | Local location | Inspected revision | Working tree at inspection |
| --- | --- | --- | --- |
| Orcus | `/home/shreyas/code/work/orcus/` | `f7c626d` | Untracked `.claude/`; source code left unchanged |
| Colosseum | `/home/shreyas/code/work/colosseum/` | `3526dbbb` | Clean |
| Arbitrum Openhouse | `/home/shreyas/code/work/arbitrum-openhouse/` | `7769578` | Existing user modifications listed below |

The product checklist originated at `orcus/docs/plans/2026-11-05-hackathon-product-checklist.md`. That source directory is Git-ignored. The initial [canonical checklist](../specs/product-checklist.md) preserved all 57 requirements and added IDs for traceability. The current CRE revision replaces the former six EF/Anon-RPC criteria and updates sponsor/demo references while retaining core product capabilities. It still has 57 items. The original source checklist was not changed.

Arbitrum Openhouse files already modified by the user:

- `apps/web/src/components/hedges/CashflowTimeline.tsx`
- `apps/web/src/components/home/SystemHealthPanel.tsx`
- `apps/web/src/components/strategies/desk/Desk.tsx`
- `apps/web/src/lib/alerts/health.ts`
- `apps/web/src/lib/treasury/revenue.ts`
- Untracked `contracts/broadcast/`

These are outside the proposed initial port. Do not overwrite them or assume their contents match the recorded revision. If a later slice needs one, review the working-tree diff and intentionally choose the version first.

Some Colosseum packages declare `UNLICENSED`. The user's permission to reuse their code is not itself an open-source license declaration for public distribution. Before publishing, confirm the intended project license and retain required third-party notices. Do not copy font assets without checking their licenses.

## R01. Application foundation and wallet UI

Source: Orcus.

- `web/package.json`
- `web/src/lib/wagmi.ts`
- `web/src/lib/evm-multichain.ts`
- `web/src/lib/use-portfolio.ts`
- `web/src/components/wallet-gate.tsx`
- `web/src/components/connect-button.tsx`
- `web/src/components/strategy-builder.tsx`
- `web/src/components/receipt-viewer.tsx`
- `web/src/components/intent-status-banner.tsx`

Destination: `web/`, with account-specific logic in `web/src/lib/wallets/` and trading/agent presentation separated into components.

Reuse the Next.js/React foundation, wallet connection, forms and status components. Replace old vault-bound data access and single-agent assumptions. Retain loading/error states while changing the domain bindings. Do not copy unrelated Sui integrations or deployment settings solely because they are present.

The inspected manifest uses Next 16.2.6 and React 19.2.4. A source instruction refers to an older Next version; use the actual package/lockfile compatibility baseline, not that stale description. Test the selected base before introducing dependency upgrades.

## R02. 0G inference boundary

Source: Orcus.

- `agent/src/tee/sealedDecide.ts`
- `agent/src/tee/sealedDecide.test.ts`
- `web/src/app/api/parse-strategy/route.ts`

Destination: `agent/src/compute/` plus a typed strategy/action parser shared with the web API.

Reuse request construction and error-handling structure where compatible with the actual credited endpoint. The current function calls a proxy chat-completions endpoint using a bearer credential. Confirm its relationship to the event's Private Computer credentials rather than assuming the old path is the correct current integration.

Required changes:

- Remove the prompt instruction to force execution for words such as "now" or "immediately", regardless of conditions.
- Validate model output against an explicit action schema. Reject invalid/unknown actions and request clarification where necessary.
- Do not turn parse failure or malformed conditions into an unconditional trade.
- Capture genuine provider request evidence and usage. A locally generated action ID is not a provider request ID.
- Add per-user authorization, budget checks and safe timeout handling.
- Verify private-inference configuration and attestation separately. The name `sealedDecide` and a hard-coded provider label are not proof of TEE execution.

The source agent manifest includes multiple generations of 0G packages: `@0gfoundation/0g-compute-ts-sdk`, `@0gfoundation/0g-ts-sdk`, `@0glabs/0g-serving-broker` and `@0glabs/0g-ts-sdk`. It also runs `patches/0g-ts-sdk-market-fix.sh` after installation. Identify the APIs actually used, select compatible packages and revalidate any patch; do not reproduce that entire dependency mixture automatically.

## R03. Strategy, indicators, encryption and receipts

Source: Orcus.

- `agent/src/strategy/schema.ts`
- `agent/src/strategy/evaluate.ts`
- `agent/src/strategy/indicators-adapter.ts`
- `agent/src/strategy/narrate.ts`
- `agent/src/indicators.ts`
- `agent/src/price/pyth.ts`
- `agent/src/crypto/ecies.ts`
- `agent/src/receipt.ts`
- `web/src/lib/strategy-schema.ts`
- `web/src/lib/encrypt.ts`
- Related agent tests, including `strategy/evaluate.test.ts`, `strategy/narrate.test.ts` and `crypto/ecies.test.ts`

Destination: pure validation/amount types in `packages/core/`; agent tools and automation in `agent/src/`.

Reuse deterministic validation, indicator computation and encryption primitives after reviewing their assumptions and tests. Pure strategy/indicator helpers can also inform the new CRE workflow after WASM compatibility review; keep Node I/O, secret handling and billable inference behind the worker boundary. Consolidate duplicated schema definitions. Adapt receipt fields to include user/account binding, action initiator, permission revision, venue evidence and accurate execution status.

The existing typed-strategy path can execute deterministically and use AI only for narration. Keep deterministic safeguards, but add meaningful 0G planning/tool selection for the new product. Do not present narration alone as the required AI capability.

## R04. 0G Storage, runtime and RPC adaptation

Source: Orcus.

- `agent/src/storage/writeReceipt.ts`
- `agent/src/storage/writeReceipt.test.ts`
- `agent/src/index.ts`
- `agent/src/rpc.ts`
- `agent/src/rpc.test.ts`
- `web/src/lib/rpc.ts`

Destination: `agent/src/storage/`, `agent/src/execution/` and `web/src/lib/rpc/`.

Use the storage upload boundary as a starting point, not as verified persistence. The current helper serializes receipt JSON, computes a root and can return that root after an upload error. Replace this with encrypted bytes, explicit pending/confirmed/failed status, retry handling and a demonstrated download/recovery path. Do not treat a computed hash as evidence that any node stored the object. Use collision-safe temporary files or a supported in-memory upload path.

The current runtime uses a singleton agent private key and in-memory seen/in-flight tracking. A transaction can be marked seen before execution, and that state disappears on restart. Replace those ownership and scheduling mechanisms with per-user credentials and a durable journal; do not copy the old main loop unchanged.

The browser RPC helper is ordinary HTTP fallback with short timeouts. Reuse it only with explicit freshness/error handling and appropriate timeout review; it provides no anonymous-read guarantee. The former Anon-RPC integration is no longer a required port after the third-sponsor change. CRE's own configured EVM reads are a distinct workflow boundary, not automatically this browser transport.

## R05. Existing Uniswap fork integration tests

Source: Orcus.

- `contracts/test/fork/sepolia-uniswap.fork.test.ts`
- `contracts/test/fork/arbitrum-uniswap.fork.test.ts`

Destination: `contracts/test/fork/`, adapted to the new owner/session execution model.

Reuse real protocol call shapes, fork setup and settlement assertions. The tests are currently coupled to the old StrategyVault and are conditional on RPC environment variables. A skipped test is not a passed live integration.

The Sepolia test uses a SwapRouter02-style tuple, while the Arbitrum test uses an original SwapRouter tuple including a deadline. Verify the selected deployment's actual ABI and avoid copying one tuple into the other call. Replace source-specific oracle assumptions and shared-vault ownership with the new account policy. Do not assume historical test liquidity is still available.

## R06. Hyperliquid enrollment and owner approval

Source: Colosseum.

- `services/solver/src/hyperliquid-testnet-enrollment.ts`
- `services/solver/src/hyperliquid-testnet-enrollment-http.ts`
- `services/api/src/hyperliquid-testnet-enrollment-proxy.ts`
- `apps/web/src/features/terminal/hyperliquid-account-setup.tsx`
- `services/solver/test/hyperliquid-testnet-enrollment.test.ts`
- `services/api/test/hyperliquid-testnet-enrollment-proxy.test.ts`

Destination: `agent/src/venues/hyperliquid/`, owner signing UI and account-scoped API routes.

Reuse native agent approval, owner binding, challenge/expiry checks and account-change handling during signing. Adapt the source's restrictive onboarding: it expects a flat, funded standard account and rejects other active agents. Our product must import supported existing positions and tolerate external account activity with reconciliation. Do not delete account-mode safety checks without implementing the replacement model.

Keep any unimplemented account modes visibly unsupported rather than treating them as interchangeable. Supported pre-existing positions are a required acceptance case, not an optional later feature.

## R07. Encrypted keys and per-user runtime isolation

Source: Colosseum.

- `services/solver/src/hyperliquid-testnet-agent-key.ts`
- `services/solver/src/hyperliquid-testnet-per-user-runtime.ts`
- `services/solver/test/hyperliquid-testnet-per-user-runtime.test.ts`

Destination: protected keystore helpers in `packages/server/` and per-account worker construction.

Reuse authenticated encryption, owner/address binding, restrictive file access, symlink/path checks and uniqueness of agent/journal/lease assignments. Do not copy legacy plaintext key-file compatibility. Encrypt secrets outside the checkout and store only references in the database.

Do not turn source account manifests into the product's permanent runtime source of truth. Enrollment creates database records. Validate account/secret binding when constructing each signer and never fall back to another user's or a shared default key.

The encrypted file design is not a TEE signer. JavaScript signing libraries can retain key material in memory; do not promise perfect memory erasure or hardware isolation because the file is encrypted.

## R08. Hyperliquid venue adapter

Source: Colosseum.

- `packages/adapters/hyperliquid/src/wire-format.ts`
- `packages/adapters/hyperliquid/src/position-adapter.ts`
- `services/solver/src/hyperliquid-testnet-executor-runtime.ts`
- `services/solver/src/hyperliquid-testnet-runtime.ts`
- `services/keeper/src/hyperliquid-recovery-testnet-ports.ts`
- `services/keeper/src/hyperliquid-evidence-collector.ts`
- `services/keeper/src/hyperliquid-recovery-reconciliation.ts`
- `services/solver/test/hyperliquid-testnet-executor-runtime.test.ts`

Destination: small Hyperliquid account-state, order, cancellation, precision and reconciliation modules.

Extract exact integer/decimal formatting, SDK transport/signing, client order IDs, response parsing and state evidence. The source uses `@nktkas/hyperliquid` 0.33.3; retain a tested version initially and verify owner-wallet as well as agent-wallet signing flows.

The larger runtime is coupled to solver strategies and multi-leg protocol behavior. Do not transplant it as the new product's main agent loop. Generalize only the operations required by the checklist, including reduce-only and protective orders, with account-specific validation.

## R09. Durable submissions, SQLite and recovery

Source: Colosseum.

- `services/api/src/durable-sqlite.ts`
- `services/api/src/execution-intent-store.ts`
- `services/api/src/advanced-order-reconciliation.ts`
- `services/keeper/src/hyperliquid-submission-journal.ts`
- `services/solver/src/hyperliquid-sqlite-journal.ts`
- `services/api/test/execution-intent-store.test.ts`
- `services/api/test/advanced-order-reconciliation.test.ts`
- `services/keeper/test/hyperliquid-submission-journal.test.ts`
- `services/solver/test/hyperliquid-sqlite-journal.test.ts`

Destination: `packages/server/` persistence plus `agent/src/execution/`.

Reuse SQLite connection discipline, durable-before-send transitions, signer leases, unknown-submission recovery and test cases. Adapt to the smaller local action/account schema instead of importing the original protocol's type graph.

The inspected submission journal assumes exactly two IOC legs. Our engine also needs individual swaps, single orders, open/partial orders, cancellations and TP/SL. Preserve durability principles, not the two-leg state assumptions. Do not claim venue operations are atomic simply because one database transaction records them.

## R10. Uniswap quoting

Source: Colosseum.

- `services/api/src/uniswap-v3-quoter.ts`
- `services/api/test/uniswap-v3-quoter.test.ts`

Destination: `agent/src/venues/uniswap/` with shared validated quote types where needed by the web UI.

Reuse signerless quote calls, exact amount handling and chain/factory/runtime verification patterns. Replace imports of protocol-wide types with minimal local interfaces. Verify deployment addresses independently for the chosen environment; old config is not proof of current deployment support.

This is a quoting component. It does not provide the new smart-account authorization, router transaction policy, owner/session signing or settlement reconciliation by itself.

## R11. Trading terminal presentation

Source: Arbitrum Openhouse.

- `apps/web/src/components/terminal/OrderTicket.tsx`
- `apps/web/src/components/terminal/OrderBookPanel.tsx`
- `apps/web/src/components/terminal/MarketSwitcher.tsx`
- `apps/web/src/components/terminal/viz/PackagePriceChart.tsx`
- `apps/web/src/components/terminal/viz/chart-utils.ts`
- `apps/web/src/components/terminal/viz/chart-icons.tsx`
- `apps/web/src/components/terminal/viz/chart-styles.ts`
- `apps/web/src/components/terminal/viz/chart-theme.ts`
- `apps/web/src/components/terminal/viz/chart-drawings.ts`
- `apps/web/src/components/terminal/viz/indicators.ts`

Destination: `web/src/components/trading/` and small formatting/chart helpers.

Reuse presentation, interactions and chart utilities. These components depend on package-market and internal market-data types; rebind them to our venue snapshots, candles, order previews and account state. Do not copy RWA term structures or generated catalog synchronization scripts to satisfy imports.

The source web manifest uses different framework versions and pnpm workspace dependencies. Do not copy its lockfile or Next/React packages over the chosen foundation. Add only dependencies actually needed by the selected UI components through npm. Live data, error states and responsive behavior take priority over drawing-tool completeness.

## R12. Position management and activity presentation

Source: Arbitrum Openhouse.

- `apps/web/src/components/positions/ManagePanel.tsx`
- `apps/web/src/components/activity/StepTimeline.tsx`
- `apps/web/src/components/activity/ActivityBlotters.tsx`
- `apps/web/src/components/activity/ActivityDetail.tsx`

Destination: shared position/order management, execution status and activity views.

Reuse confirmation/preflight presentation, status timelines and account-level activity layouts. Replace close/roll/settle package-contract semantics with actual spot or perpetual actions. Show initiator, pending/partial states, last refresh and final venue evidence. Never map an API acknowledgement directly to a completed step.

Colosseum's terminal components are useful secondary references for venue-specific controls, but importing its entire terminal context would pull in unrelated protocol machinery. Prefer one coherent UI built from these selected sources.

## R13. CRE workflow and runner

Source: new integration, using the official CRE CLI/SDK and selective pure logic from R03. No inspected source project establishes an existing CRE workflow.

Destination: `workflows/cre/` for workflow code/configuration and `agent/src/automation/` for durable scheduling, bounded CLI invocation and result handoff.

Use the [official CRE templates](https://github.com/smartcontractkit/cre-templates/) as a starting point after checking their actual interfaces and license. Do not invent a custom simulator and label it CRE.

Implement real EVM reads and external HTTP observations, idempotent proposal retrieval, approved-condition checks and structured allow/reject/no-action results. Adapt pure evaluators only where compatible with the WASM runtime; keep wallet signing, encrypted key storage, 0G API credentials and durable execution in the Node worker.

The existing source job/journal patterns can support scheduling and recovery, but runner authentication, evaluation binding, expiry/control revisions and replay handling are new work. Use the actual CLI result format verified in the integration spike. Simulation evidence is local, not a production DON signature. Hosted access, fees and report verification must be verified separately before introducing that mode.

## New work that the source code does not establish

- The complete user-owned smart-account plus bounded session-key flow for Uniswap.
- Unified manual/agent action contracts, shared account handoff and external-position reconciliation in this product.
- A meaningful CRE workflow, its WASM/toolchain compatibility, real chain/API calls and durable authenticated runner-to-execution handoff.
- Per-user authorization across the combined web, worker, budget and memory paths.
- Proven 0G private-inference configuration and actual operating-wallet-to-compute replenishment.
- Encrypted memory upload confirmation, download and restart recovery.
- A coherent end-to-end UI and sponsor evidence for this repository.

Reusing source code accelerates these tasks; it does not mark them complete.

## Validation performed during planning

Environment inspected: Node v22.16.0, npm 11.6.4.

Attempted in the original Orcus `agent/` package:

```sh
npm test -- --reporter=dot src/strategy/evaluate.test.ts src/crypto/ecies.test.ts src/storage/writeReceipt.test.ts src/tee/sealedDecide.test.ts src/rpc.test.ts
```

Result: exit 127, `vitest: command not found`. The selected tests did not execute. No dependencies were installed to change that source checkout. No Colosseum or Arbitrum Openhouse suite was executed during this planning pass.

The next implementation slice must install dependencies in the target, run the selected source-derived tests and document baseline failures before modifying the underlying behavior. Add regression tests for the specific unsafe inherited behavior identified above.

## R14. External open-source product intake

Inspected: 2026-11-06. These are research snapshots, not runtime configuration. Six shallow clones are available under the target repository's ignored `inspiration/` directory. Each clone's README was checked with `git check-ignore`. No cloned scripts, dependency installation, deployment, signing or source-code import was performed during this inspection.

| Product | Inspected source | License | Concrete reusable areas |
| --- | --- | --- | --- |
| Condor | [hummingbot/condor, f825393](https://github.com/hummingbot/condor/tree/f825393daa8f98c89ffe9e5708f1b7cefcd37dfc) | [MIT](https://github.com/hummingbot/condor/blob/f825393daa8f98c89ffe9e5708f1b7cefcd37dfc/LICENSE) | Full trading-agent application: risk gates, executor ownership/adoption, personal memory, routines, reports and React portfolio views. |
| Hummingbot | [hummingbot/hummingbot, 9af100d](https://github.com/hummingbot/hummingbot/tree/9af100d6822da7d2d0291a906c730ef172284ee2) | [Apache-2.0](https://github.com/hummingbot/hummingbot/blob/9af100d6822da7d2d0291a906c730ef172284ee2/LICENSE) | Mature Python trading engine: Hyperliquid spot/perpetual connectors, fills, order tracking, balances and venue precision. |
| Gateway | [hummingbot/gateway, f23e916](https://github.com/hummingbot/gateway/tree/f23e91670781fba75eb023edecaf2d992f0918aa) | [Apache-2.0](https://github.com/hummingbot/gateway/blob/f23e91670781fba75eb023edecaf2d992f0918aa/LICENSE) | Substantial TypeScript DEX service: Uniswap routing, quotes, LP positions, Permit2 checks and confirmation handling. |
| ElizaOS | [elizaOS/eliza, 795ddb18](https://github.com/elizaOS/eliza/tree/795ddb18f2fcbd2b1e3f7a897eafa531417cc0ef) | [Core MIT](https://github.com/elizaOS/eliza/blob/795ddb18f2fcbd2b1e3f7a897eafa531417cc0ef/packages/core/LICENSE) | Agent runtime, task scheduling, trigger math, approval services and pause-race regression cases. |
| LangGraph JS | [langchain-ai/langgraphjs, 6fb340e](https://github.com/langchain-ai/langgraphjs/tree/6fb340e306e33f95cdb2d2a0a7eaebcc154152f1) | [MIT](https://github.com/langchain-ai/langgraphjs/blob/6fb340e306e33f95cdb2d2a0a7eaebcc154152f1/LICENSE) | Durable graph execution, checkpoint savers, tool nodes, interrupts and resumable human approval. |
| AgentKit | [coinbase/agentkit, f2f3e8c](https://github.com/coinbase/agentkit/tree/f2f3e8c11a91d56a17979a229a172ba6e61a85c2) | [Apache-2.0](https://github.com/coinbase/agentkit/blob/f2f3e8c11a91d56a17979a229a172ba6e61a85c2/LICENSE.md) | Schema-bound action providers, network filtering and MCP/tool adapters. Not a drop-in trading terminal. |

### Highest-value selective intake

Selected immediate runtime intake: Condor's `mcp_servers/_profiles.py` and `condor/acp/pydantic_ai_client.py` provide fail-closed tool profiles and definition filtering before model invocation. Adapt the profile mechanism to distinguish interactive chat from unattended strategy ticks. A strategy tick should receive read tools plus typed trade proposals, not memory mutation, nested automation creation or arbitrary execution. Enforce the profile again when invoking a tool; removing it from the prompt alone is insufficient. Unknown profiles must fail rather than widen to a full tool set. This fits the current feature boundary without adding cron, new infrastructure or owner signing rights.

Implemented selective ports on 2026-11-06:

- Condor profile registration, model-definition filtering and invocation refusal now live in `agent/src/compute/tool-profiles.ts`. Interactive and strategy modes have separate allowlists, and checkpoint replay is profile-bound. The source notice is in `agent/src/compute/NOTICE.md`; `licenses/condor-LICENSE.txt` preserves MIT terms.
- Hummingbot's explicit order states, order-scoped fills and duplicate trade-ID handling are adapted in `agent/src/venues/hyperliquid/lifecycle.ts`. Quantities and fees use exact integers. A partially filled cancelled IOC stays terminal while exposing observed fill evidence; unavailable history is not represented as zero execution. Apache terms and modification notices are in `licenses/hummingbot-LICENSE.txt` and `licenses/hummingbot-NOTICE.md`.
- These modules are copied/adapted into the application with focused tests. No runtime import depends on `inspiration/`, and no upstream runtime, wallet loader or builder-fee attribution was installed.

1. **ElizaOS scheduling is the cleanest substantial TypeScript port.** `packages/core/src/services/trigger-scheduling.ts` contains 551 lines of cron, timezone, DST-deduplication and next-run computation with only a type import from `types/trigger`. Port the selected functions and their type definitions if the product accepts daily/timezone schedules; retain the 60-second minimum and fail closed on malformed schedules. The current Orcus automation schema is interval-based, so this is a real capability addition, not a replacement for CRE evaluation. `services/task-scheduler.ts` and `test/task.pause-race.pglite.test.ts` provide cancellation/generation and stale-read regression patterns. Do not import the entire runtime or replace persisted account leases.

2. **Condor supplies actual trading-agent behavior.** Inspect `condor/runtime/danger.py`, `condor/agents/risk.py`, `condor/agents/executor_adoption.py`, `condor/agents/ownership.py` and `condor/fetchers/portfolio.py`. Useful bounded ports include read-versus-mutation tool classification, exposure-reducing action exceptions, leverage/drift/drawdown checks, orphaned-execution reconciliation and unified-account balance deduplication. The classifier is Python stdlib-only; the full application requires Python 3.12, Pydantic AI, Hummingbot API, FastAPI and other services. Its React 19 portfolio and routine components can be adapted separately, with its API types and navigation replaced. Preserve Orcus's explicit owner authorization when adopting a manually opened position; do not copy a session-only ownership rule unchanged.

3. **Hummingbot is strongest for venue lifecycle edge cases.** Source modules are `hummingbot/connector/client_order_tracker.py`, `connector/derivative/hyperliquid_perpetual/hyperliquid_perpetual_derivative.py` and the matching user-stream source/tests. Specific useful paths are `_process_trade_rs_event_message`, `_request_order_status`, `_process_order_message`, `_format_trading_rules` and `_update_balances`. They distinguish order updates from fills, retain late-fill tracking and cover account abstraction modes. Port focused logic/test fixtures into the existing TypeScript adapter instead of introducing its Python/Cython runtime. Keep unknown submissions pending until independently reconciled. Do not import its builder-fee attribution or credentials configuration.

4. **Gateway is a future routing/LP expansion source, not a safe immediate signer replacement.** Concrete modules: `src/connectors/uniswap/alpha-router.ts`, `universal-router.ts`, `clmm-routes/positionsOwned.ts`, and `test/connectors/uniswap/clmm-routes/positions-owned-completeness.test.ts`. Its current connector has more than 3,000 lines of router/core integration and uses ethers 5, Fastify and Uniswap SDKs. It can accelerate route selection and complete LP enumeration, including zero-liquidity NFTs with fees. However, its wallet-loader/default-wallet paths conflict with per-user owner signing. Its Universal Router/Permit2 calldata also differs from Orcus's narrowly authorized single-call SwapRouter02 policy. New routing requires a separately reviewed owner grant, not relaxed current permissions. Replace floating-point execution amounts with exact units.

### Already-used or lower-priority frameworks

The current `agent/src/compute/agent.ts` already uses LangGraph `StateGraph`, and `compute/tools.ts` uses LangChain structured tools. Continue consuming the maintained packages. LangGraph's `libs/checkpoint-sqlite/src/index.ts` is useful if full graph checkpoint replay becomes necessary, but requires `better-sqlite3`, LangChain core and the checkpoint protocol; it is not interchangeable with Orcus's current user-bound encrypted-backup/checkpoint format.

AgentKit's `typescript/agentkit/src/action-providers/actionProvider.ts` and `typescript/framework-extensions/model-context-protocol/src/index.ts` are useful for schema-bound tool adapters. No general Hyperliquid action provider was found in the inspected TypeScript source. The Uniswap helpers found are under its WoW-specific integration, not a general order engine. Its ZeroDev provider uses a different Kernel/intent-executor setup and sudo signing, so it must not replace Orcus's scoped session path. Installing the complete toolkit would add unrelated providers and initialization telemetry; selective intake is more appropriate.

Condor's `routine_store.py` explicitly describes install-wide shared agent/routine definitions, while Orcus requires user isolation. Its filesystem memory also does not replace Orcus's existing scoped SQLite notes, secret rejection and encrypted 0G backup. These are integration constraints, not reasons to discard the useful execution and risk modules.

### Source notices and dependency boundaries

For MIT source, retain the applicable copyright and license notice with substantial copied portions. ElizaOS's core package carries a separate 2025 notice from the root's 2026 notice; retain the notice belonging to the copied package. For Apache-2.0 source, include the license, retain applicable notices, identify modified files and preserve any applicable upstream NOTICE content. Inspect vendored subdirectories and assets separately rather than assuming the root license covers every dependency or logo. These source notices are distinct from prohibited AI attribution in commits.

No broad product fork is recommended for the hackathon at this point. The immediate reuse opportunity is bounded source modules and their existing edge-case fixtures, retaining the current 0G inference, owner/agent execution and CRE authorization boundaries. No feature is marked complete merely because its source was cloned.
