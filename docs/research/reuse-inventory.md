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
