# Hackathon Product Checklist

Updated: 2026-11-06

Implementation checklist for this repository. IDs link to the [implementation plan](../plans/implementation-plan.md). All core user and agent capabilities are retained; the six former EF/Anon-RPC requirements in section 9 are replaced by CRE requirements in this revision. The current count remains 57. Source provenance is recorded separately in the [reuse inventory](../research/reuse-inventory.md).

Build a personal-agent trading platform where users can research, trade and manage positions themselves or through their authorized agent. Both interfaces operate on the same supported trading accounts. Privacy supports the product; it does not turn public trades into private transactions.

Sponsor targets: **0G + Uniswap + Chainlink CRE**. Hyperliquid is an additional trading integration, not a fourth sponsor target. Target the CRE workflow bounty; CCIP and Anon-RPC are not required integrations.

This is the product acceptance checklist in build order. Unchecked means not yet verified end to end against this checklist, not necessarily missing from the existing code.

Current verification, 2026-11-06: real 0G inference, sealed gateway-reported inference, memory write/recall, live market/candle tools, typed order/alert drafts, duplicate billing prevention and budget stops pass through the authenticated application. A separately authorized encrypted storage upload/download/restore passed on Galileo with platform-paid fees and zero 0G in both the test user's wallet and its agent operating wallet. Real Uniswap owner/agent swaps and native permission rejection pass on an isolated Sepolia fork. One public Galileo storage transaction was submitted; there were no public contract deployments or funded public trades.

Compute replenishment is implemented with owner policy, exact beneficiary/network binding, caps, idempotency, receipt recovery and Router-credit synchronization checks. It remains disabled for the supplied production Router key: Galileo deposits cannot replenish that account, and an inference key does not verify its funding beneficiary. Optional earned-funding mode is not enabled or represented as complete.

Checked items have direct local evidence or the stated isolated-fork proof. Unchecked items can have complete software but still lack their required funded/provider/CLI or submission acceptance. Fixture-backed tests are not presented as funded external execution. The current verification covers 404 application tests plus three CRE capability-fixture tests, application/workflow typechecks, and production/CRE WASM builds. Public deployments are intentionally outside this completion pass. See the [dated verification record](../research/verification-2026-11-06.md).

The low-friction trading pass adds shared manual/agent gas sponsorship, an authenticated and scoped paymaster proxy, per-operation/user/project caps, native ETH input with explicit agent opt-in, pre-signing external-deposit gas checks, safe error messages and pending-deposit recovery across refreshes. Hosted gas sponsorship is not configured locally and is not claimed as live. Native ETH output, bridges and mainnet trading remain disabled. Dependency-audit findings also remain a production gate.

| Area | Implementation and verification | Remaining external acceptance |
| --- | --- | --- |
| Personal agent and memory | Real signed HTTP tool loops and actual encrypted 0G upload/download/restore after reopening the database; platform payer spent 0.001259629469494168 testnet 0G | Independent strict attestation remains separate; normal end users do not need native 0G for this sponsored path |
| Shared trading | Shared adapters, permissions, reviewed proposals, takeover and durable action audit; real owner/session native ETH input swaps on local fork; capped sponsorship/proxy and receipt recovery implemented | External bundler/paymaster policy and sponsored execution proof; funded Hyperliquid owner approval/trades |
| Private inference | Explicit gateway-reported sealed mode passes; strict hardware/code verifier and certificate pinning fail closed | Hash-matching raw app-compose manifest is unavailable from the live gateway's public attestation service |
| Operating budget | Actual Router billing plus USD-equivalent ledger; platform-paid storage with global payer locking and daily/per-backup caps; capped compute deposits and receipt recovery implemented | Management-read credential, matching testnet Router account and actual compute deposit/credit-sync proof; real service-payment checkout is not implemented |
| CRE | Real SDK workflow, WASM build, authenticated handoff, durable runner, allow/reject consumption and restart fixtures | CLI authentication is unavailable; owner will provide it later. No successful live simulation is claimed |
| Sponsor submission | Setup, source/license notices, integration references and feedback file are present | Public repo, feedback form, judge-accessible deployment and recorded demo require owner/publication actions |

## 1. Wallet connection and personal agent

- [ ] `C1.1` Connect the user's wallet and load supported balances, positions and orders. Never request a seed phrase or private key.
- [x] `C1.2` Create a personal agent with its own preferences, memory and separate signing credentials. Do not reuse one execution key across users.
- [x] `C1.3` Create an agent operating wallet with a limited expense budget, separate from trading capital.
- [ ] `C1.4` Show the owner wallet, trading accounts and operating wallet distinctly. One dashboard does not imply one shared address across every venue.

## 2. User ownership and agent authorization

- [x] `C2.1` Keep wallet connection separate from trading authorization. The user explicitly approves agent access in their wallet.
- [x] `C2.2` For Uniswap, use a user-owned ERC-4337 smart account with Kernel's scoped permission modules. Actual owner/session behavior is verified on the isolated Sepolia fork; external bundler acceptance remains a separate gate.
- [ ] `C2.3` Make smart-account funding an explicit user-approved action. Connecting an existing wallet does not transfer its tokens or grant control over them. Check the external owner's token and gas balance before signing, distinguish deposits from bridges, and preserve unresolved transfer recovery across refreshes.
- [ ] `C2.4` For Hyperliquid, use native agent-wallet authorization for the user's existing account. Read positions using the trading account's address, not the agent signer's address.
- [ ] `C2.5` Provide permission review, expiry, revocation and key rotation. The agent cannot change ownership or grant itself broader permissions.
- [x] `C2.6` Keep withdrawals and permission changes owner-controlled. Store agent credentials in protected signing infrastructure, never in model prompts, plaintext memory or public storage. Private inference does not itself secure wallet signing keys.
- [x] `C2.7` Distinguish account-enforced restrictions from application-only risk limits. Do not claim Hyperliquid agent authorization natively enforces every custom per-trade limit.

## 3. Unified dashboard and manual trading

- [ ] `C3.1` Show balances, open positions, pending orders, P&L, recent activity and agent operating costs.
- [x] `C3.2` Support manual Uniswap spot swaps with quote, approval, slippage, fee and confirmation states. Native ETH input atomically wraps the exact reviewed amount; WETH output is labelled honestly. Sponsorship must be approved before signing, with no silent owner-paid fallback. Native execution is fork-verified; external paymaster acceptance remains separate.
- [ ] `C3.3` Support manual Hyperliquid orders, cancellation, position reduction and closing, plus supported stop-loss and take-profit controls.
- [x] `C3.4` Clearly distinguish spot holdings from leveraged positions. Selling a spot holding is not the same operation as closing a perpetual position.
- [x] `C3.5` Display live, pending, failed and stale states accurately. Do not show an API acknowledgement as a confirmed fill.

## 4. Full agent capabilities

- [x] `C4.1` Use 0G inference for meaningful research, analysis, planning and action selection, not merely narration around hard-coded trades.
- [ ] `C4.2` Let users request swaps, supported orders, position changes and explanations through conversation.
- [ ] `C4.3` Support both approval-required actions and autonomous execution within explicitly granted permissions.
- [ ] `C4.4` Let the agent manage manually opened positions in an authorized account, including supported positions opened outside our interface.
- [x] `C4.5` Let users manually manage positions opened by the agent. Do not create separate user-only and agent-only portfolios.
- [ ] `C4.6` Require clarification or confirmation for ambiguous instructions such as "close it" when multiple positions could match.

## 5. Shared execution and safe handoff

- [x] `C5.1` Route manual and agent actions through the same venue adapters, validation and account-state reconciliation.
- [x] `C5.2` Check permissions outside the LLM. Validate account, asset, recipient, amount, slippage, expiry and supported action before signing.
- [x] `C5.3` For EVM delegation, constrain actual transaction contents, not just a generic router address. Do not give a session key unrestricted router commands or token approvals.
- [x] `C5.4` Refresh positions before modifying them. Use reduce-only orders for supported perpetual closing operations so a stale request cannot unintentionally reverse exposure.
- [x] `C5.5` Prevent duplicate submissions and conflicting actions with account-level coordination, unique action IDs and venue-aware nonce handling.
- [x] `C5.6` Provide Pause Agent and Take Over controls. Stop queued automation and reconcile pending actions; do not claim already-submitted transactions can always be cancelled.
- [x] `C5.7` Record who initiated each action, the instruction, permission decision, resulting order or transaction and final status, without exposing secrets.

## 6. Background automation

- [ ] `C6.1` Run a durable worker and actual CRE workflow for conditional monitoring, scheduled purchases, alerts and approved strategies. The worker schedules bounded simulations and reconciles execution; automation must not depend on the browser remaining open.
- [ ] `C6.2` Show active, paused, expired, insufficient-budget and failed states for each automation.
- [ ] `C6.3` Define the caller, gas payer and retry policy for each execution. Avoid duplicate trades after a restart or timeout.
- [ ] `C6.4` Pause unsafe new actions on stale data, expired authorization or unavailable dependencies. Preserve manual controls and previously placed protective orders where the venue permits.

## 7. 0G inference and persistent memory

- [x] `C7.1` Capture real 0G inference request IDs in the main agent workflow and show them in the technical demo.
- [ ] `C7.2` Verify the selected provider's private-inference mode and attestation path before labelling reasoning private or TEE-protected. Do not silently downgrade private requests.
- [x] `C7.3` Encrypt persistent preferences, agent memory and sensitive execution context before uploading to 0G Storage. Keep decryption keys separate.
- [x] `C7.4` Demonstrate memory retrieval after an agent restart. Avoid publicly publishing raw prompts, trading strategies or account mappings.
- [x] `C7.5` Explain the dependency honestly: removing 0G stops the configured AI planning and analysis; manual trading should still be usable where its other dependencies are available.

## 8. Agent operating budget

- [ ] `C8.1` Let users explicitly fund a capped service/compute budget and inspect spending separately from trading performance. The platform may pay backend native gas; ordinary users must not need 0G merely to use inference or sponsored storage. Cost allowances exist; actual user-payment collection remains unfinished.
- [ ] `C8.2` Track compute balance, expenditure, replenishment status and low-budget warnings. An onchain wallet balance is not automatically a spendable compute balance.
- [ ] `C8.3` Implement an authorized replenishment path into the actual 0G compute account, with spend caps and payment evidence. Never silently spend trading principal.
- [x] `C8.4` Degrade safely or pause when the operating budget runs low. Do not promise that an agent runs forever without funding.
- [ ] `C8.5` If optional earned-funding mode is enabled, demonstrate genuine service revenue reaching the agent's compute account and paying for subsequent inference without manual top-ups. Only then describe it as self-sustaining.
- [x] `C8.6` Do not require a token launch. Sponsor credits and owner deposits do not prove earned revenue.

## 9. Chainlink CRE strategy orchestration

Revision note: C9.1-C9.6 now describe CRE acceptance, replacing their former EF/Anon-RPC meanings. No private-read guarantee is carried over. Wallet protection, encrypted memory and verified 0G privacy requirements remain unchanged.

- [ ] `C9.1` Run an actual CRE workflow that reads the target blockchain and an external API/system, consumes structured 0G planning where needed, and evaluates an approved strategy. Its result must drive a real automation feature, not just a log or unused simulation.
- [ ] `C9.2` Demonstrate successful CLI simulation with real configured testnet/RPC and HTTP calls. Label it local simulation, not hosted execution or DON consensus. Confirm CLI authentication, toolchain and account-enabled networks; do not assume testnet makes third-party services free.
- [ ] `C9.3` Bind workflow results to the strategy, user/trading account, network, evaluation/proposal IDs, approved policy version, observation time/block and expiry. Deduplicate proposal generation so retries do not multiply billable inference.
- [ ] `C9.4` Authenticate the runner-to-worker handoff and validate outputs before consumption. Keep wallet keys outside CRE and independently check current permission/control revisions and risk limits before signing. A CRE allow result is not wallet authorization; manual and immediate conversational controls remain separate.
- [ ] `C9.5` Persist scheduling and evaluation state, prevent duplicate executions, and show active, no-action, rejected, paused and failed states. Stop affected conditional jobs on stale data, revoked authority, low budget or runner failure without disabling owner exits or venue-native protective orders.
- [ ] `C9.6` Show an allowed action and a rejected candidate end to end, with CLI evidence, observations, 0G request/proposal and actual venue evidence. Document runner availability, authentication, costs/quotas, data exposure and the simulation trust boundary; hosted approval/report verification is a separate future gate.

## 10. Sponsor acceptance and demo

- [ ] `C10.1` **0G:** working judge-accessible agent flow, real request IDs, a concrete recurring use case and a demo under three minutes. Enter the self-sustaining bounty only if its complete earned-funding loop works.
- [ ] `C10.2` **Uniswap:** meaningful working swap integration, public open-source repo, integration code references, `FEEDBACK.md` and the required developer feedback form.
- [ ] `C10.3` **Chainlink CRE:** a meaningfully used workflow connecting onchain state with external data or our agent, successful CLI simulation, real result consumption, allow/reject evidence and documented local-runner requirements. Do not add CCIP solely to claim another bounty.
- [x] `C10.4` Use supported testnet or local-fork routes for development and demonstration. Confirm venue compatibility and required balances without relying on mainnet funds.
- [x] `C10.5` Demonstrate: user manually opens a position; agent reduces or closes that same position; user takes over again.
- [x] `C10.6` Demonstrate: an agent-created position can be managed manually; expired or revoked permissions prevent subsequent agent actions.
- [ ] `C10.7` Demonstrate: conflicting actions, stale state, duplicate CRE results, low operating budget and an unavailable workflow runner produce understandable, safe outcomes.

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
