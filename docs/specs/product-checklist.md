# Hackathon Product Checklist

Updated: 2026-11-06

Implementation checklist for this repository. IDs link to the [implementation plan](../plans/implementation-plan.md). All core user and agent capabilities are retained; the six former EF/Anon-RPC requirements in section 9 are replaced by CRE requirements in this revision. There are now 67 items, including ten new workspace and return-to-session requirements in section 11. The earlier 53/57 completion baseline does not include this new work. Source provenance is recorded separately in the [reuse inventory](../research/reuse-inventory.md).

Build a personal-agent trading platform where users can research, trade and manage positions themselves or through their authorized agent. Both interfaces operate on the same supported trading accounts. Privacy supports the product; it does not turn public trades into private transactions.

Sponsor targets: **0G + Uniswap + Chainlink CRE**. Hyperliquid is an additional trading integration, not a fourth sponsor target. Target the CRE workflow bounty; CCIP and Anon-RPC are not required integrations.

This is the implementation checklist in build order. A checked item means the feature and its safeguards are implemented with the local, fixture, fork or dated live evidence stated here. It does not imply current provider availability, public deployment or complete browser-extension acceptance. Unchecked items are remaining combined acceptance, publication or explicitly optional requirements. The table below keeps external gates separate from feature completion.

Verification on 2026-11-06 includes earlier successful real 0G inference, gateway-reported sealed inference, memory write/recall, market/candle tools, typed order/alert drafts, duplicate billing prevention and budget stops through authenticated HTTP. The latest isolated recheck stopped at its first upstream HTTP 502: billing was unverified and its ledger held 0.010000 USD equivalent at failure. The temporary proof database was later lost after reboot, not reconciled; no retry, zero-charge result or new restart proof is claimed. A separately authorized encrypted storage upload/download/restore passed on Galileo with platform-paid fees and zero 0G in both synthetic user accounts. Actual Uniswap owner/agent swaps and native permission rejection passed on an isolated Sepolia fork. One approved public Hyperliquid testnet position proved authorization, owner/agent handoff, protective stop/TP cancellation and a flat/revoked finish: 19.84522 mock USDC opening notional and 0.017865 mock USDC total fees. No public contract deployment or mainnet trade was performed.

Compute replenishment is implemented with owner policy, exact beneficiary/network binding, caps, idempotency, receipt recovery and Router-credit synchronization checks. It remains disabled for the supplied production Router key: Galileo deposits cannot replenish that account, and an inference key does not verify its funding beneficiary. Optional earned-funding mode is not enabled or represented as complete.

Authenticated CRE CLI simulation now passes five cases with real chain/HTTP observations, including a worker-consumed alert persisted across SQLite reopen without a duplicate action or notification. The actual operator-paymaster fork proves six successful operations and nine denials with zero ETH in the owner and agent signer wallets. Seven Chromium cases pass against the real local HTTP/SQLite application with disposable injected wallets, not an installed extension. Post-reboot serial checks at source `df9428f` passed 643 workspace tests, all workspace typechecks, the production build, nine separate CRE fixtures, 40 contract/helper checks, nine script helpers and workflow typecheck/WASM build. Focused counts overlap and are not extra unique tests. The [dated verification record](../research/verification-2026-11-06.md) preserves exact scopes; fixture-backed tests are never presented as paid external execution.

The low-friction trading pass adds shared manual/agent gas sponsorship, a scoped authenticated paymaster proxy, operation/user/project caps, native ETH input with explicit agent opt-in, external-deposit gas checks and pending-deposit recovery. The platform wallet is the primary gas payer; ZeroDev hosted sponsorship is an explicit secondary only. Public operator-paymaster deployment, EntryPoint deposit/stake and canonical bundler admission remain external gates. Native ETH output, bridges and mainnet trading remain disabled. Root dependency audits report no known findings after compatibility fixes; the separate CRE dependency audit is tracked in the verification record. Neither is a formal security certification.

| Area | Implementation and verification | Remaining external acceptance |
| --- | --- | --- |
| Personal agent and memory | Earlier real HTTP tool loops and encrypted 0G upload/download/restore after database reopen; storage payer spent 0.001259629469494168 testnet 0G | Latest inference recheck returned 502 with unknown billing held; no automatic retry. Normal users do not need native 0G for the sponsored path |
| Shared trading | Shared adapters, permissions, takeover and audit; owner/session fork swaps; actual capped Hyperliquid handoff/revocation; operator-paymaster fork with six operations and nine denials | Public paymaster deployment, EntryPoint deposit/stake, canonical bundler admission and external sponsored settlement; installed-extension acceptance |
| Private inference | Earlier explicit gateway-reported sealed inference; independent verifier, certificate pinning and no-downgrade failure path implemented | Hash-matching raw app-compose manifest remains unavailable; no independent strict-TEE success is claimed |
| Operating budget | Actual earlier Router billing, separate service-credit/allowance ledgers, owner-scoped unknown-bill recovery, exact Circle USDC checkout on fork, platform-paid storage, and actual deployed Galileo PaymentVault deposit/recovery on fork | Live management-history recovery, matching Router funding account and post-deposit credit synchronization remain unproven. Recovery tests and fork management input use fixtures; live money and earned funding stay disabled |
| CRE | Five successful authenticated CLI cases with real observations, actual worker alert consumption and persistence/no-duplicate proof; bounded proposal and failure/restart fixtures | Combined actual 0G proposal -> CRE decision -> permissioned venue settlement remains unproven. Hosted DON approval/report verification is separate and not required for simulation |
| Sponsor submission | Setup, source/license notices, integration references and feedback file are present | Public repo, feedback form, judge-accessible deployment and recorded demo require owner/publication actions |

## 1. Wallet connection and personal agent

- [x] `C1.1` Connect the user's wallet and load supported balances, positions and orders. Never request a seed phrase or private key. Local Chromium acceptance verified signed HTTP login, actual owned account registration and supported live public account reads with a disposable injected wallet; real-extension behavior remains separate.
- [x] `C1.2` Create a personal agent with its own preferences, memory and separate signing credentials. Do not reuse one execution key across users.
- [x] `C1.3` Create an agent operating wallet with a limited expense budget, separate from trading capital.
- [x] `C1.4` Show the owner wallet, trading accounts and operating wallet distinctly. One dashboard does not imply one shared address across every venue. Component and actual local-browser checks verify all three labels, including the venue account sharing its owner's address honestly.

## 2. User ownership and agent authorization

- [x] `C2.1` Keep wallet connection separate from trading authorization. The user explicitly approves agent access in their wallet.
- [x] `C2.2` For Uniswap, use a user-owned ERC-4337 smart account with Kernel's scoped permission modules. Actual owner/session behavior is verified on the isolated Sepolia fork; external bundler acceptance remains a separate gate.
- [x] `C2.3` Make smart-account funding an explicit user-approved action. Connecting does not transfer tokens or grant control. Owner/network checks, token/gas preflight and durable pending-transfer recovery are implemented and regression-tested; public funding is not claimed.
- [x] `C2.4` For Hyperliquid, use native agent-wallet authorization for the user's existing account. Read positions using the trading account's address, not the agent signer's address. A separately approved live testnet run verified the fresh grant, shared position reads and revocation without replacing an existing named agent.
- [x] `C2.5` Provide permission review, expiry, revocation and key rotation. Preserve old signer addresses for owner recovery; local pause/rotation never claims native revocation without venue proof. Hyperliquid native revocation is live-testnet verified and Kernel expiry is fork-verified. Kernel recovery/revocation code is unit-covered where applicable, not fork-proven native revocation; public sponsored revocation still needs deployment and bundler acceptance.
- [x] `C2.6` Keep withdrawals and permission changes owner-controlled. Store agent credentials in protected signing infrastructure, never in model prompts, plaintext memory or public storage. Private inference does not itself secure wallet signing keys.
- [x] `C2.7` Distinguish account-enforced restrictions from application-only risk limits. Do not claim Hyperliquid agent authorization natively enforces every custom per-trade limit.

## 3. Unified dashboard and manual trading

- [x] `C3.1` Show balances, open positions, pending orders, P&L, recent activity and agent operating costs. Missing/stale venue data is labelled, not synthesized as live performance; local browser acceptance covers account-role separation.
- [x] `C3.2` Support manual Uniswap spot swaps with quote, approval, slippage, fee and confirmation states. Native ETH input atomically wraps the exact reviewed amount; WETH output is labelled honestly. Sponsorship must be approved before signing, with no silent owner-paid fallback. Native execution is fork-verified; external paymaster acceptance remains separate.
- [x] `C3.3` Support manual Hyperliquid orders, cancellation, position reduction and closing, plus supported stop-loss and take-profit controls. Shared adapters and owner-signing guards are tested; the capped public testnet run proved an owner opening, agent protection/close and both owner/agent cancellation paths.
- [x] `C3.4` Clearly distinguish spot holdings from leveraged positions. Selling a spot holding is not the same operation as closing a perpetual position.
- [x] `C3.5` Display live, pending, failed and stale states accurately. Do not show an API acknowledgement as a confirmed fill.

## 4. Full agent capabilities

- [x] `C4.1` Use 0G inference for meaningful research, analysis, planning and action selection, not merely narration around hard-coded trades.
- [x] `C4.2` Let users request swaps, supported orders, position changes and explanations through conversation. Earlier real 0G runs produced typed order/alert drafts; policy and persistence tests cover supported action routing. Those drafts did not themselves submit a public trade.
- [x] `C4.3` Support both approval-required actions and autonomous execution within explicitly granted permissions. Both paths share deterministic validation, ownership and reconciliation; fixture/fork tests cover authorization rather than trusting model assertions.
- [x] `C4.4` Let the agent manage manually opened positions in an authorized account, including supported positions opened outside our interface. The live testnet proof opened once with the owner signer; the native agent placed protective orders and closed that exact account's position.
- [x] `C4.5` Let users manually manage positions opened by the agent. Do not create separate user-only and agent-only portfolios.
- [x] `C4.6` Require clarification or confirmation for ambiguous instructions such as "close it" when multiple positions could match. The proposal tool requires exactly one explicit instrument token; substring collisions such as "whether"/ETH, multiple named positions and mismatched targets are rejected in regression fixtures.

## 5. Shared execution and safe handoff

- [x] `C5.1` Route manual and agent actions through the same venue adapters, validation and account-state reconciliation.
- [x] `C5.2` Check permissions outside the LLM. Validate account, asset, recipient, amount, slippage, expiry and supported action before signing.
- [x] `C5.3` For EVM delegation, constrain actual transaction contents, not just a generic router address. Do not give a session key unrestricted router commands or token approvals.
- [x] `C5.4` Refresh positions before modifying them. Use reduce-only orders for supported perpetual closing operations so a stale request cannot unintentionally reverse exposure.
- [x] `C5.5` Prevent duplicate submissions and conflicting actions with account-level coordination, unique action IDs and venue-aware nonce handling.
- [x] `C5.6` Provide Pause Agent and Take Over controls. Stop queued automation and reconcile pending actions; do not claim already-submitted transactions can always be cancelled.
- [x] `C5.7` Record who initiated each action, the instruction, permission decision, resulting order or transaction and final status, without exposing secrets.

## 6. Background automation

- [x] `C6.1` Run a durable worker and actual CRE workflow for conditional monitoring, scheduled purchases, alerts and approved strategies. A real CLI alert evaluation reached the worker and survived SQLite reopen without duplication; trade scheduling/execution guards have regression coverage. The combined live 0G/CRE/trade demonstration remains `C9.6`.
- [x] `C6.2` Show active, paused, expired, insufficient-budget and failed states for each automation. Local browser acceptance verifies expired resume is disabled and rejected by the actual API; state fixtures cover owner pause, budget and safe runner-error recovery without exposing provider details.
- [x] `C6.3` Define the caller, gas payer and retry policy for each execution. Persist intent before submission, reconcile unknown outcomes and deduplicate requests/evaluations across restart. Operator gas funding remains separate from trading principal and service credits.
- [x] `C6.4` Pause unsafe new actions on stale data, expired authorization or unavailable dependencies. Regression tests cover changed control revisions, budget exhaustion and runner failure; owner controls and venue-native protective orders are not silently removed.

## 7. 0G inference and persistent memory

- [x] `C7.1` Capture real 0G inference request IDs in the main agent workflow and show them in the technical demo.
- [x] `C7.2` Verify the selected provider's private-inference mode and attestation path before labelling reasoning private or TEE-protected. The official independent verifier/certificate-pin gate is implemented and fails closed because its required manifest is unavailable; earlier gateway-reported sealed runs carry only that weaker assurance. No silent downgrade or independent strict-TEE success is claimed.
- [x] `C7.3` Encrypt persistent preferences, agent memory and sensitive execution context before uploading to 0G Storage. Keep decryption keys separate.
- [x] `C7.4` Demonstrate memory retrieval after an agent restart. Avoid publicly publishing raw prompts, trading strategies or account mappings.
- [x] `C7.5` Explain the dependency honestly: removing 0G stops the configured AI planning and analysis; manual trading should still be usable where its other dependencies are available.

## 8. Agent operating budget

- [x] `C8.1` Let users explicitly fund a capped service/compute budget and inspect spending separately from trading performance. Exact Sepolia USDC receipt verification grants test-only credits, proven on an isolated fork with restart/replay checks. The owner expense cap does not mint credits. Ordinary users do not need 0G for inference or sponsored storage. Live-money collection remains disabled.
- [x] `C8.2` Track service-credit balances, expenditure, reservations, releases, replenishment status and low-budget warnings. Keep configured provider-credit evidence distinct from the customer's service-credit ledger and report unavailable or unknown-unit balances honestly. Unknown expenses expose a read-only Check provider billing action with owner-switch/duplicate-click guards. Exact original account/request identity, complete usage history and a verified USD cost are required to settle once; missing, conflicting or native-only evidence stays held. HTTP error billing is not treated as free. HTTP, replay, restart and UI regressions pass; actual management-history access remains an external gate. An onchain wallet balance is not automatically a spendable compute balance.
- [x] `C8.3` Implement an authorized replenishment path into the actual 0G compute account, with spend caps and payment evidence. Exact-beneficiary Galileo PaymentVault deposit and SQLite-reopen recovery are fork-verified. A matching Router management balance and credit synchronization remain an external acceptance gate; fixture-backed management input never unlocks ordinary production funding or spends trading principal.
- [x] `C8.4` Degrade safely or pause when the operating budget runs low. Do not promise that an agent runs forever without funding.
- [ ] `C8.5` If optional earned-funding mode is enabled, demonstrate genuine service revenue reaching the agent's compute account and paying for subsequent inference without manual top-ups. Only then describe it as self-sustaining.
- [x] `C8.6` Do not require a token launch. Sponsor credits and owner deposits do not prove earned revenue.

## 9. Chainlink CRE strategy orchestration

Revision note: C9.1-C9.6 now describe CRE acceptance, replacing their former EF/Anon-RPC meanings. No private-read guarantee is carried over. Wallet protection, encrypted memory and verified 0G privacy requirements remain unchanged.

- [x] `C9.1` Run an actual CRE workflow reading target-chain state and external data, with bounded structured planning input where needed. Its real alert result is consumed by the durable worker, not merely logged. Combined inference-to-trade evidence is separately required by `C9.6`.
- [x] `C9.2` Demonstrate successful authenticated CLI simulation with real testnet/RPC and HTTP calls. Five cases passed: native-input allow, token-balance reject, condition no-action, altered-proposal reject and a worker-consumed alert. This is local simulation, not hosted DON consensus or a free-service entitlement.
- [x] `C9.3` Bind results to strategy, account/network, evaluation/proposal IDs, policy/control revisions, observations and expiry. Namespaced persistent proposal caches and budget reservations prevent repeated evaluation references from multiplying inference; signed HTTP/restart regressions use explicitly mocked inference.
- [x] `C9.4` Authenticate runner handoff and validate outputs before consumption. Keep wallet keys outside CRE and independently recheck authorization and limits before signing. A CRE allow is not wallet authorization; manual/immediate controls remain separate.
- [x] `C9.5` Persist scheduling/evaluation state and show active, no-action, rejected, paused and failed states. Actual CLI alert consumption survives SQLite reopen without duplication; regression fixtures cover stale/changed authority, low budget and runner failures without disabling owner exits.
- [ ] `C9.6` Show an allowed action and a rejected candidate end to end, with CLI evidence, observations, 0G request/proposal and actual venue evidence. Document runner availability, authentication, costs/quotas, data exposure and the simulation trust boundary; hosted approval/report verification is a separate future gate.

## 10. Sponsor acceptance and demo

- [ ] `C10.1` **0G:** working judge-accessible agent flow, real request IDs, a concrete recurring use case and a demo under three minutes. Enter the self-sustaining bounty only if its complete earned-funding loop works.
- [ ] `C10.2` **Uniswap:** meaningful working swap integration, public open-source repo, integration code references, `FEEDBACK.md` and the required developer feedback form.
- [x] `C10.3` **Chainlink CRE integration:** a meaningfully used onchain/external-data workflow, successful authenticated CLI simulation, actual worker result consumption, allow/reject evidence and documented local-runner requirements. Public packaging and the combined trading demo remain separate gates; no forced CCIP integration.
- [x] `C10.4` Use supported testnet or local-fork routes for development and demonstration. Confirm venue compatibility and required balances without relying on mainnet funds.
- [x] `C10.5` Demonstrate: user manually opens a position; agent reduces or closes that same position; user takes over again.
- [x] `C10.6` Demonstrate: an agent-created position can be managed manually; expired or revoked permissions prevent subsequent agent actions.
- [x] `C10.7` Implement and verify safe outcomes for conflicting actions, stale state, duplicate CRE results, low budget and unavailable runners through regression/browser tests. Recording these scenarios in the final judge demo remains a publication task, not a claim of public execution.

## 11. Professional workspace and return-to-session experience

This is newly requested implementation work, not a claim that the earlier terminal already meets these requirements. Keep the existing execution and wallet safeguards while improving the complete product interface. The public landing preview remains separate at `/landing`.

- [ ] `C11.1` Provide a real overview dashboard and URL-addressable Trade, Agent, Automations, Activity and Settings pages with shared navigation, working deep links and browser back/forward behavior. Show actual balances, exposure, pending work and operating costs; do not invent account value or performance charts.
- [ ] `C11.2` Reuse compatible terminal presentation and interaction patterns for charts, market selection, order entry and account tables. Manual and agent controls continue to manage the same accounts, with spot and perpetual exposure clearly distinguished.
- [ ] `C11.3` Persist an agent request before accepting background execution. Returning users can discover queued, running, completed, failed or interrupted work and its saved answer. Duplicate requests, server restart and unknown inference billing must not trigger automatic duplicate model calls or trades.
- [ ] `C11.4` Recover trade and funding progress from existing durable records after navigation or reconnect. Clearly distinguish awaiting owner approval, submitted, reconciling, confirmed, failed and unknown outcomes. Never silently repeat a signature, transfer or trade when a user returns.
- [ ] `C11.5` Provide an owner-scoped activity center with useful filters and detail views connecting an instruction, initiator, run, action, venue evidence and final status where those records exist. Pending work must remain visible without relying on a disappearing toast.
- [ ] `C11.6` Provide a dedicated agent workspace with restored conversation, discoverable run progress, saved responses, actionable proposals and existing memory and permission controls. Switching wallets must clear private state and ignore late responses from the previous owner.
- [ ] `C11.7` Give automations, operating budget and account settings dedicated page layouts with clear setup, unavailable, pending, error and success states. Preserve pause/takeover, permission expiry/revocation, service-credit separation and explicit sponsorship readiness.
- [ ] `C11.8` Use the actual protocol and supported-token logos throughout the product. Keep network/testnet badges and feature availability explicit; a decorative asset or read-only market listing must not imply execution support.
- [ ] `C11.9` Verify worthwhile trading additions against official Hyperliquid and Uniswap documentation before implementation. Add useful supported market context such as real order-book depth and funding, and truthful swap execution/quote details, without forcing another venue, bridge, lending product or unapproved permission expansion.
- [ ] `C11.10` Review the real dashboard and terminal visually on desktop and mobile, including empty/loading/error states and return-to-session behavior. Run focused regression tests and typechecks serially within the established memory cap; do not equate a mock display with live execution proof.

## Scope boundaries

- No token launch, compulsory pooled vault or invented private-trading mode.
- No forced Hedera, Arkiv, Anon-RPC, CCIP or extra sponsor integration.
- No claim that merely connecting a wallet authorizes the agent or makes every existing position controllable.
- No promise of arbitrary venue support. Add adapters without changing the ownership and permission model.
- Keep all manual and agent capabilities above in the hackathon product; these are build-order checkpoints, not a six-month release roadmap.

## Implementation references

- [Kernel permissions](https://docs.zerodev.app/smart-accounts/permissions/intro)
- [Hyperliquid API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)
- [Hyperliquid Exchange API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)
- [Uniswap developer documentation](https://developers.uniswap.org/docs)
- [CRE overview](https://docs.chain.link/cre/overview)
- [CRE simulation](https://docs.chain.link/cre/guides/operations/simulating-workflows)
- [CRE quotas](https://docs.chain.link/cre/service-quotas)
- [CRE deployment access](https://docs.chain.link/cre/guides/operations/deploy-access)

Sponsor acceptance items follow the supplied event track descriptions. These references support implementation choices; they are not application runtime configuration.
