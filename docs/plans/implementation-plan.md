# Hackathon Implementation Plan

Date: 2026-11-06
Status: local implementation and acceptance closeout. Real 0G tool loops, gateway-reported sealed inference, memory writes/recovery and provider-reported billing pass through authenticated HTTP. An authorized, platform-paid encrypted storage round trip passes on Galileo with zero native 0G in the synthetic user's accounts. Actual Uniswap/Kernel fork operations prove shared owner/agent control and native permission rejection. Capped compute-funding policies, APIs, UI and durable recovery are implemented. The supplied production Router key is not a verified Galileo funding account. CRE authentication will be supplied later; no live simulation or hosted deployment is claimed. See the checklist and dated verification record for remaining external gates.

## 1. Product and fixed scope

Build a personal-agent trading platform. A user connects their wallet, authorizes their own agent, and can research, trade, automate and manage the same supported accounts through either the interface or conversation. The agent has its own operating wallet and separate, restricted trading credentials. The user's private key never leaves their wallet.

The [product checklist](../specs/product-checklist.md) contains 57 current acceptance items. This revision replaces the former EF/Anon-RPC sponsor requirements with Chainlink CRE requirements; all manual trading, agent, ownership, memory and budget capabilities remain. The passes below are execution order within the hackathon, not a sequence of future product releases. Optional earned funding remains optional exactly as in the checklist.

| Integration | Actual product responsibility | What we must demonstrate |
| --- | --- | --- |
| 0G | AI research and planning; encrypted persistent memory; compute expenditure and authorized replenishment | Real inference request IDs, a useful action plan, restored memory and actual compute-account spending |
| Uniswap | Spot swaps from a user-owned account, initiated manually or by a scoped agent | Real quote, permission checks, transaction and settled token changes |
| Chainlink CRE | Real onchain/external observations, conditional strategy orchestration and candidate validation | A CRE CLI workflow that drives an authorized strategy, rejects unsafe inputs and produces evidence consumed by the execution worker |
| Hyperliquid | Perpetual trading and management of existing user positions | Native owner approval of an agent, manual and agent actions on the same trading account |

The first three are sponsor targets. Hyperliquid is a venue, not another sponsor. Target the supplied Best workflow with CRE bounty, which accepts successful CLI simulation; do not add CCIP solely for another prize. CRE is not a wallet signer or a replacement for owner permissions. Local simulation does not prove decentralized consensus or DON-signed production execution. Private 0G inference remains a separately verified capability.

Do not add a token, pooled trading vault, Arkiv, Hedera, an INR rail, a bridge or a shielded-trading claim to complete this scope. Anon-RPC is no longer a required integration or a fourth sponsor target. Keep encrypted memory, key protection and evidence-based 0G privacy claims. Preserve an adapter boundary for more venues without implementing every venue now.

## 2. Reuse decision

Use the existing application as the foundation, selected Hyperliquid execution components as the venue implementation, and selected terminal components for the interface. Do not merge three entire products.

Exact original paths, revisions and known problems belong in the [reuse inventory](../research/reuse-inventory.md). Implementation tasks below refer to its reuse IDs so source provenance does not become product configuration or leak into UI copy.

| Reuse IDs | Bring over and adapt | Do not bring over |
| --- | --- | --- |
| R01-R05 | Next.js shell, wallet connection, strategy validation, indicators, compute/storage boundaries, receipt UI and fork-test patterns | Shared-agent vault ownership, dark-pool assumptions, forced-execution prompts, fake persistence success, unrelated chain integrations |
| R06-R10 | Native Hyperliquid approval, encrypted agent-key handling, exact order formatting, durable submission/reconciliation patterns and quoting | Flat-account onboarding, exclusive-agent requirement, fixed two-leg IOC execution, protocol-wide solver/keeper machinery |
| R11-R12 | Chart, order-ticket, order-book, position-management and activity presentation | RWA lifecycle semantics, old market manifests, app-specific backend contracts and unrelated dashboard modules |
| R13 | Existing pure strategy logic where compatible, used inside a new CRE workflow | Claims that a CRE runner, report verifier or workflow already exists in the inspected source |

Port the smallest working dependency closure, including relevant tests. Adapt imports and domain types locally. Do not preserve old package names merely to make a large import graph compile.

## 3. Small target structure

Use npm consistently. Keep the working framework versions from the selected base initially; resolve actual compatibility conflicts individually. Do not combine lockfiles from different package managers or install every dependency used by the source products.

```text
web/                         Next.js interface and authenticated HTTP routes
  src/app/                   Trading, agent settings and activity screens
  src/components/trading/    Chart, order ticket, positions and orders
  src/components/agent/      Chat, action preview, permissions and budget
  src/lib/wallets/            Owner signing and venue authorization
  src/lib/rpc/                Explicit browser read transport and freshness handling
  src/server/                Session auth and account-scoped API handlers
agent/                       Durable worker and protected signing service
  src/compute/               0G inference adapter and evidence
  src/storage/               Encrypted memory upload and recovery
  src/execution/             Policy validation, leases, journal, reconciliation
  src/venues/uniswap/        Quotes, bounded calls and settlement checks
  src/venues/hyperliquid/    Account state, orders, approval and reconciliation
  src/automation/            Durable jobs, CRE runner, evaluation handoff and alerts
  src/budget/                Operating ledger and compute replenishment
packages/core/               Shared validated plans, money types and states
packages/server/             Database, migrations, auth and keystore helpers
workflows/cre/               CLI-generated TypeScript workflow, config and simulation tests
contracts/                   Existing Hardhat test harness; bounded executor only if needed
docs/specs/                 Product acceptance checklist
docs/plans/                 Implementation sequence
docs/research/              Reference-only reuse evidence
```

These are planned destinations, not existing implementations. Keep web and worker as the two main application processes; the worker manages bounded CRE CLI child processes for the simulation demo. No separate service is needed for each adapter. Generate the CRE project with the official CLI and use its required WASM build toolchain, while retaining npm for the application. Do not transplant the Node agent or its signing/storage dependencies into the CRE WASM runtime. Shared packages must not introduce circular dependencies.

Use one SQLite database on persistent local disk for the hackathon deployment, with WAL, foreign keys, transactional updates and account-scoped leases. Run web and worker where they can safely share that disk; do not use ephemeral serverless storage or a network filesystem as a shortcut. Encrypted 0G objects are memory backups, not the transaction queue or authoritative account balance.

Reuse the existing Vitest agent test setup and Hardhat contract tests. Run shared-module tests through the existing test setup. No new UI automation framework is required: keep a reproducible manual end-to-end script for browser signing, plus unit/integration tests for execution boundaries.

## 4. Account and control model

| Account or credential | Owner and purpose | Agent authority |
| --- | --- | --- |
| Connected owner wallet | User's external wallet; login, ownership, deposits and permission changes | None merely from connection; never give its key to the server or model |
| Uniswap smart account | User-owned account funded by an explicit transfer | Separate session signer with bounded actions, limits, expiry and revocation |
| Hyperliquid trading account | User's supported existing venue account | Native approved agent key; trading authority does not imply all our app limits are venue-enforced |
| Agent operating wallet | Separate, user-authorized expense balance | Bounded spending for configured operating costs, initially actual 0G compute replenishment |

One logical personal agent can have different signing credentials for different venues. Do not reuse a global agent key or confuse an API wallet address with the account holding positions.

### Uniswap path

1. Connect the owner wallet and create or recover its smart account. Use ERC-4337 with Kernel permissions if the compatibility gate below succeeds.
2. Show the smart-account address and let the owner explicitly fund it. Tokens remaining in the owner's EOA are not automatically agent-controllable.
3. The owner signs manual smart-account actions. A separately authorized agent signer can submit only approved action types.
4. Start with a direct Uniswap V3 quote and router integration using R05/R10. An extra Trading API key is not required for that path. Verify the selected router ABI, factory, chain and liquidity; do not mix SwapRouter and SwapRouter02 parameters.
5. Validate token pair, recipient equal to the user's smart account, input amount, amount-out minimum, deadline and bounded approvals. Reject arbitrary router command payloads and arbitrary recipients.
6. Prefer maintained account permission modules. If their policies cannot enforce the required call restrictions, implement and test a narrow swap executor instead of permitting generic unrestricted router execution. This is a gate, not an excuse to weaken authorization.
7. Record the transaction and reconcile receipt status plus actual token changes. A spot swap does not create a perpetual position.

ERC-4337 handles account abstraction; it does not itself specify session-key spending limits. Permit2, if introduced for a compatible route, is token allowance/signature machinery, not general agent authorization. Test contract-wallet signing compatibility before choosing that route.

### Hyperliquid path

1. Load state for the user's owner/trading address, including positions opened outside our app.
2. Generate a fresh per-user, per-environment agent key and store it encrypted outside the checkout. The owner approves its address through the venue's native approval flow.
3. Manual actions use the owner's wallet signing path; autonomous actions use the approved agent signing path. Both operate on the same account and position state.
4. Show supported account modes explicitly. Remove the inherited requirement to close every position before onboarding, but retain account-mode validation and establish a baseline before automation starts.
5. Preserve order precision, client order IDs, signer-specific nonces, cancellation, partial-fill handling and order reconciliation. Acknowledged is not filled.
6. Refresh account state before reducing or closing. Use supported reduce-only semantics and handle the case where the position was already changed by the owner or another client.
7. Expose expiry and owner revocation. App-level budgets and asset allowlists must be labeled app-enforced unless the venue actually enforces them. Protecting the agent key remains essential.

### Backend expense payer

Ordinary users do not need native 0G for inference or platform-sponsored storage. The backend uses its credited Router key for inference and a separate capped operator signer for Galileo storage gas and storage value. User-specific memory keys and trading credentials remain isolated. Operator storage shares a payer-wide nonce lock and daily native cap; the operator key never reaches the model or browser. Agent-paid storage remains an optional advanced mode, not a default customer requirement.

The expense cap and service-payment ledger are separate. Optional `ORCUS_SERVICE_PAYMENT_MODE=testnet` enables an exact Sepolia USDC checkout to the configured `ORCUS_SERVICE_PAYMENT_TREASURY`; default `disabled` preserves explicitly operator-covered inference. Verified owner transfers grant test-only credits at the fixed one-USDC-to-one-USD-equivalent rate. Reserve, settle and release credits atomically alongside the owner expense cap, retaining unknown costs. A cap increase cannot create credits. No live-money collection, real revenue or automatic currency conversion is claimed.

Record a pending intent before the wallet opens. Verify exact chain, owner, token, treasury, amount, zero native value, post-creation block, canonical receipt and two confirmations. Deduplicate the transfer event globally and preserve reconciliation across restarts. Expiry blocks new wallet flows, never forfeits an otherwise exact successful transfer that mines late. Show separate recovery for an unknown hash or delayed receipt. Owner switches invalidate pending UI responses and locks. Trading principal and collateral stay separate from service costs. An external-wallet deposit or checkout still needs owner-paid Sepolia gas; checkout verifies token balance and a fee ceiling of 0.003 ETH before opening the wallet.

### Low-friction trading and gas

Keep the existing Kernel account and venue adapters. Improve the experience without introducing a new wallet, bridge, token or customer infrastructure balance.

1. Connect and sign in with the owner wallet. Derive the same user-owned trading account without requiring a live bundler just to calculate its address. No funds move at this step.
2. Fund the selected venue explicitly. Show the receiving account, supported network, asset and amount. A transfer from an external wallet is owner-signed and needs that wallet's native gas. Never present a same-chain deposit as a cross-chain bridge.
3. Default supported smart-account execution to the platform's own wallet-funded paymaster with `ORCUS_GAS_SPONSOR_PROVIDER=operator` and a generic `BUNDLER_RPC_URL`. Keep its approval signer on the server, bind sponsorship to the authenticated user's reviewed operation, and cap individual operations and daily usage. Paymaster deployment, EntryPoint ETH deposit and locked stake remain operator actions. Verify `getDepositInfo`, the actual authorized signer and the selected bundler's configured stake policy before issuing approval. Configuration is not proof of funded sponsorship or public bundler admission.
4. Apply the same sponsorship path to manual and agent actions. Obtain and validate sponsorship before signing. Do not silently retry with the user's native balance if the sponsor rejects or is unavailable.
5. Native ETH input is an atomic conversion to the verified WETH contract followed by the protected spot swap, not a separate custody vault. Agent grants require an explicit bounded native-wrap opt-in; existing zero-value permissions do not grow automatically. WETH output must be labelled WETH rather than native ETH.
6. Keep one reviewed action and its transaction evidence through wallet approval, submission, receipt uncertainty and reconciliation. Disable duplicate submission while the result is unknown. Account, chain or control changes invalidate stale reviews.
7. Missing provider configuration, unsupported routes and insufficient balances produce actionable states before signing. Preserve owner recovery information; an unavailable sponsor is not proof of a revoked agent permission.

The existing Kernel SDK and account addresses remain unchanged. ZeroDev's hosted service is an explicit secondary only: `ORCUS_GAS_SPONSOR_PROVIDER=zerodev` selects its server-only endpoints. Missing or rejected operator sponsorship never switches to it, and never enables owner-paid gas automatically. Customers do not create a provider account. Both paths use the authenticated same-origin `orcus_sponsorUserOperation` proxy with separate non-consuming estimation and final approval. Operators must deploy/fund the primary paymaster and verify generic bundler acceptance, including the initial permission-enrollment gas cost, before claiming live sponsored execution.

### Ownership and takeover rules

- Connecting a wallet enables reads. A signed, one-time login challenge establishes the authenticated user. Venue delegation is a separate explicit signature.
- Owner-only operations include permission changes, withdrawals, operating-budget changes and authorizing automation.
- Keep agent credentials out of prompts, browser responses, logs, memory snapshots and public storage. Do not port a legacy plaintext-key fallback.
- Pause Agent stops future queued actions and releases scheduling authority. Take Over also invalidates stale planned actions by incrementing an account control revision.
- An in-flight signed order or transaction cannot always be stopped. Show it as reconciling and query the venue before retrying or reporting takeover complete.
- Local leases cannot lock someone out of trading through another app. Detect changed balances, positions and orders and re-plan or pause rather than promising global atomic control.
- Revoking automation must not prevent the owner from closing positions or withdrawing through the venue. Previously placed protective orders must be handled explicitly, not silently removed.

## 5. One execution pipeline for both interfaces

### CRE strategy workflow and trust boundary

CRE powers conditional automation, not just an unused timer. Manual trades and immediate conversational commands still use the shared execution path below. Venue-native protective orders remain native to the venue rather than relying on periodic CRE evaluation.

1. The owner approves a strategy and its limits. The durable worker selects a due job, records an evaluation ID and snapshots the account control revision and approved policy version.
2. The runner invokes the actual CRE workflow. CRE reads current holdings or relevant contract state through its EVM capability and calls an external market-data API. A simulation must use real configured endpoints, not mocked results presented as live.
3. Where planning is needed, CRE requests a structured 0G proposal through an authenticated internal worker endpoint. The worker reserves the compute budget and deduplicates by evaluation ID; repeated workflow calls return the same proposal rather than paying for inference repeatedly. Persist request status before calling 0G. If a timeout leaves provider usage unknown, hold the evaluation for reconciliation instead of blindly retrying a potentially billable request. Never place a raw billable 0G call in per-node execution without a deduplication design.
4. CRE evaluates the approved strategy conditions, observation freshness and candidate limits. Return allow, reject or no-action with the evaluation ID, strategy/account/network binding, proposal ID, policy version, observed block/time, expiry and reasons.
5. The runner validates the output and delivers it to the execution worker. In local mode this is trusted operator infrastructure, explicitly labeled simulation; do not invent a DON signature or accept a client-supplied approval flag as a valid result.
6. Before signing, the worker independently checks current owner authorization, policy/control revisions, fresh balances/positions, amount, recipient, slippage, budget and idempotency. Only the approved venue signer can submit. A CRE allow result is never permission to exceed the owner's grant.
7. Persist the resulting transaction/order evidence and show the entire evaluation-to-settlement chain in activity. Reject expired, duplicate, wrong-account and superseded evaluations. A no-action result completes the evaluation without pretending a trade happened.

Keep authentication credentials scoped to internal evaluation endpoints, with allowed endpoint destinations and bounded request sizes. Pass only the needed action/observation fields to CRE, not wallet secrets, full chat history or decrypted agent memory. Standard CRE execution is not automatically confidential.

The CLI does not provide an always-on simulated cron service. For the hackathon, our worker schedules each one-shot evaluation with bounded concurrency, timeout, backoff and persisted next-run state. If the runner stops, conditional automation stops and the UI shows it. Do not let a second ordinary evaluator continue the same strategy while CRE is shown as its orchestrator.

Manual owner controls, immediate conversational actions and existing native protective orders remain usable where their own dependencies and permissions allow. A CRE outage pauses the affected conditional jobs; it does not justify disabling owner exits.

Keep local and hosted modes explicit. Local output is authenticated by our process/runner boundary, not by production DON consensus. A future hosted route requires deployment approval, verified report/callback authentication and confirmed fees/access. Do not accept simulated evidence as a production report.

### Shared action execution

```text
Manual order ticket OR immediate agent conversation OR CRE-evaluated conditional automation
  -> validated ActionPlan
  -> current account state + permission revision
  -> deterministic policy and risk checks
  -> preview / required user confirmation
  -> owner signer OR restricted agent signer
  -> venue submission + durable journal
  -> venue reconciliation
  -> one shared activity and positions view
```

The model proposes typed tools such as read portfolio, quote swap, place order, cancel order, reduce position and schedule strategy. Only registered tool schemas are accepted. It never constructs unrestricted calldata or decides its own permissions.

Required `ActionPlan` fields: action ID, user/account/network binding, initiator, action type, instrument/token addresses, exact decimal or integer quantity, limits, state observation time, control revision and confirmation requirement. Record human-readable reasoning separately from executable fields.

Represent execution as prepared, awaiting owner approval, submitting, submitted-unknown, pending/partially-filled, confirmed, rejected or cancelled. Distinguish cancelled-before-submission from a venue-confirmed cancellation. A timeout is not proof of failure. Persist intent before sending, then reconcile by transaction hash or venue/client order ID before any retry.

### Minimal database records

| Record | Main responsibility |
| --- | --- |
| Users and sessions | Wallet binding, one-time login nonce, expiry and owner-scoped access |
| Agents and trading accounts | Personal preferences, venue account identifiers and supported modes |
| Permissions and key references | Public signer address, authority type, expiry, policy revision; encrypted secret references only |
| Action intents and execution events | Idempotency, submit evidence, fills/errors, initiator and current status |
| Account leases and cursors | Worker coordination, control revisions and restart reconciliation |
| Automation jobs and evaluations | Approved strategy version, schedule, evaluation/proposal IDs, source mode, observation expiry, decision and retry state |
| Operating ledger and replenishments | Allowed budget, credits, actual debits, reserved expenses and payment evidence |
| Memory versions | Confirmed encrypted object references, schema version and recovery metadata |

Use database migrations and server-side account ownership checks. Source snapshots and copied market catalogs are reference material, not a permanent user, role, permission or job registry.

## 6. Build passes and exit checks

### P0. Copy selectively and prove the external dependencies

- Initialize the new repo and retain this plan/checklist as the agreed scope. Copy source files, not source `.git` directories, secrets, databases, broadcast artifacts or installed packages.
- Preserve the source revisions in the reuse inventory. Review licenses before the public open-source submission; some source packages currently declare `UNLICENSED`.
- Bring over R01/R03 and their selected tests. Establish npm scripts for dev, worker, typecheck, test and build without a broad dependency upgrade.
- Run a tiny real inference request using the credits already available. Verify endpoint, model, authentication and request-ID evidence. Classify credentials as app-wide or genuinely per-user before presenting account balances.
- Prove actual compute-account funding/replenishment and required payment asset/network. Demo credits alone do not prove the operating wallet can replenish them. Treat a missing funding interface as an explicit blocker for that checklist item.
- Prove one encrypted 0G upload and download round trip. Upload failure must not return a successful persistence status.
- Generate and run one actual CRE workflow that combines a target-chain read and external HTTP call. Confirm CLI login, SDK/toolchain versions, organization-enabled chains and the exact simulation output format. Use `cre workflow supported-chains` after authentication to check availability; do not assume a custom local fork is supported because it is EVM-compatible.
- Prove structured runner-to-worker handoff, internal endpoint authentication and duplicate evaluation handling. Check that repeated requests do not multiply billable 0G inference. No hosted deployment approval is needed for local simulation; no paid tier, starter credits or zero-cost hosting entitlement is assumed.
- Test a bounded workflow against the current documented quotas and observe latency. The published limits are not evidence of an unlimited workflow per user. Keep the demo to a small number of real accounts and query batches; do not route every user action through CRE.
- Verify the EVM test environment: Sepolia is the first candidate, not a promised deployment. Require supported smart-account infrastructure, correctly identified Uniswap contracts and usable test liquidity. Use a fork for repeatable tests; a local fork is not automatically a judge-accessible live venue.
- Verify Hyperliquid testnet access, funding and supported account mode with a dedicated test owner. Do not submit a real order using someone else's account or mainnet funds.

Exit: base builds, copied unit tests run, and a short compatibility table records what works and what is blocked. No provider, TEE or chain-support claim is inferred merely from successful TypeScript compilation.

### P1. Establish owner, accounts, storage and signing boundaries

- Add wallet-signed login with nonce/expiry/domain binding; validate server-side and prevent replay. Authorize every mutable route against its user/account, not a supplied wallet address alone.
- Create the per-user agent, operating wallet and account records. Display their separate addresses.
- Implement encrypted credentials using R06/R07, without legacy plaintext import. Keep key material outside the repo, restrict file permissions and redact logs.
- Add smart-account owner/session setup and native Hyperliquid agent approval. Read imported positions before enabling automation.
- Implement permissions review, revocation, rotation, control revisions and account leases. Bind approved strategy versions and CRE evaluations to these same records.

Exit: two users cannot access each other's records, signers or budgets; connecting alone cannot trade; revoked/expired agent authority blocks new agent actions while owner controls remain available.

### P2. Ship the real manual execution spine

- Implement the common plan, policy, journal and reconciliation interfaces before attaching chat.
- Bring over R05/R08/R09/R10 as small adapters. Preserve integer-based amount and precision handling.
- Implement Uniswap quote, bounded allowance, manual owner execution and settlement display.
- Implement Hyperliquid manual open, cancel, reduce, close and supported TP/SL flows, including partial fills and pre-existing positions.
- Use explicit, reliable browser read transports and show freshness/errors. Ordinary RPC reads are not anonymous; remove the former mandatory Anon-RPC transport and privacy badge.
- Use a minimal working trading screen now; adapt R11/R12 presentation as the underlying actions become real. Do not wait for a polished terminal to test settlement.

Exit: the owner can trade and manage real test accounts with 0G inference disabled. No fabricated positions, fake fills or stale balance shown as live.

### P3. Attach the full personal agent and prove handoff

- Use 0G to produce validated, meaningful action plans from user intent and retrieved context. Reuse indicators for observations and hard checks, not as a substitute for the planned AI workflow.
- Replace forced-execution prompt shortcuts and permissive parse fallbacks. Invalid JSON, unsupported assets or ambiguous instructions must produce an error or clarification, never an unconditional trade.
- Add research/read-only tools, explanations, quotes, swaps, order changes, position management and schedule creation through the shared pipeline.
- Support explicit confirmation and policy-authorized autonomous mode. An LLM assertion that the user approved is never authorization.
- Add in-product request evidence and actual execution history without exposing private prompts or keys. Make structured proposals retrievable by evaluation ID so a CRE evaluation can consume them without duplicating inference.
- Prove manual-open then agent-reduce/close, agent-open then manual-manage, and import an existing supported position opened through another interface.

Exit: the agent controls the same account state as the user; takeover and ambiguity behave safely; manual features still work when inference is unavailable.

### P4. Complete automation, memory and operating budget

- Run scheduled monitoring, DCA, alerts and authorized strategies using the CRE workflow above. The worker owns durable job scheduling, protected signing and reconciliation; CRE owns each selected job's observations, condition evaluation and candidate checks. Persist job states, evaluation evidence and next evaluation time. Do not add CRE as a parallel log-only demonstration.
- Reserve each evaluation before starting the CLI, enforce timeouts and reject late or out-of-order outputs. Recheck account/policy revisions after the workflow returns and before submission. Pause affected jobs on missing authentication, failed observations, exhausted budget or unavailable CRE. Keep manual controls and venue-native protective orders separate.
- On startup, reconcile uncertain submissions before resuming jobs. Add bounded retries, stale-data checks and safe pause on expired permissions.
- Encrypt memory before upload, confirm persistence, store the versioned reference, and restore after restart. Preserve upload failures as failures with retriable work, not imaginary stored receipts.
- Show compute balance, owner-funded budget, actual consumption and replenishment separately. Serialize spending reservations so concurrent requests cannot both consume the same remaining budget.
- Use the real funding path proven in P0. Restrict replenishment to approved destination/account and caps; wait for funding confirmation before treating it as spendable compute.
- Surface low balance, exhausted credits, funding pending/failed and storage failure. Pause new autonomous risk when needed without disabling manual exits or pretending protective orders disappeared.
- If genuine earned funding is enabled: sell an actual opted-in service, record payment, route its authorized revenue to compute, and show the next inference consuming it. No token, fabricated customer, self-trading revenue or assumption of profitable trading. If that loop is not demonstrated, call the feature budgeted/self-paying, not self-sustaining, and do not enter that extra bounty.

Exit: browser-closed operation and restart recovery work; memory returns; actual compute debits and a capped replenishment are evidenced; low budget does not trigger unauthorized capital transfers.

### P5. Finish the unified interface and workflow demonstration

- Adapt R11/R12 into one terminal: instrument selector, chart, order ticket, balances, positions, orders, activity, agent chat and settings.
- Present spot holdings separately from leveraged positions. Use real venue feeds and mark missing/stale prices. Do not reuse a fixture-backed P&L calculation as live performance.
- Give every order a clear preview, signing/pending/filled/error state and initiator. Add permission expiry, Pause Agent, Take Over and operating-cost panels.
- Add a visible strategy evaluation timeline: onchain observation, external data freshness, 0G request/proposal, CRE decision, permission check and actual venue settlement. Clearly label local simulation separately from deployed DON execution.
- Demonstrate one permitted automated action and one rejected candidate. Also show no-action, stale observations, duplicate delivery, permission revocation and stopped-runner states without fake fills or hidden manual submission.
- Document the data sent to CRE, APIs and RPCs. Do not claim anonymous reads, confidential CRE execution or private trades. Preserve verified 0G private-inference behavior and encrypted memory independently of the third sponsor.
- Verify private-inference configuration and attestation independently. If unavailable, leave TEE protection unverified and clearly mark which privacy protections actually work; do not silently downgrade a request explicitly requiring private inference.

Exit: UI reflects actual backend/venue state, CRE decisions drive the demonstrated strategy and the simulation/hosting boundary is visible. The demonstration works without hidden manual fixes.

### P6. Verify, package and rehearse

- Complete the acceptance matrix below with evidence. Leave any unverified requirement unchecked and identify the specific blocker.
- Run selected unit/integration suites, contract/fork tests, typecheck and builds. Report conditional fork-test skips separately from passes.
- Rehearse a short live flow using test funds and record the three-minute video. Include the same-account handoff, real 0G request evidence and a CRE-driven strategy with both allow and reject outcomes. Preserve the CLI command/output, workflow code and resulting testnet transaction evidence.
- Add setup, architecture, environment-variable names, account/network assumptions and limitations to the README. Include actual deployment addresses only after verifying them.
- Complete `FEEDBACK.md` and the Uniswap developer feedback form. Document 0G integration observations, CRE setup/simulation instructions, actual calls and execution evidence. Target the supplied $1,500 CRE category, not the CCIP category; hosted deployment is optional for that bounty.
- Record inherited versus newly implemented code honestly. Reuse does not establish which event eligibility category applies; do not represent copied code as new work.
- Commit bounded implementation slices with their tests. Never copy credentials, working databases or deployment key files into Git.

Exit: another person can run the documented product, and each sponsor integration is demonstrated in the main experience rather than an isolated mock.

## 7. Acceptance and test coverage

| Checklist IDs | Implementation passes | Required evidence |
| --- | --- | --- |
| C1.1, C1.2, C1.3, C1.4 | P1, P2, P5 | Wallet connection, distinct account addresses, per-user isolation and no private-key request |
| C2.1, C2.2, C2.3, C2.4, C2.5, C2.6, C2.7 | P0, P1, P2 | Explicit funding/delegation, scoped EVM calls, native venue approval, revocation and accurate restriction labels |
| C3.1, C3.2, C3.3, C3.4, C3.5 | P2, P5 | Real manual swaps/orders, TP/SL, reconciled fills, spot/perp distinction and stale states |
| C4.1, C4.2, C4.3, C4.4, C4.5, C4.6 | P3 | Meaningful 0G plans, both approval modes, external-position import, both handoff directions and ambiguity rejection |
| C5.1, C5.2, C5.3, C5.4, C5.5, C5.6, C5.7 | P1-P3 | Shared adapters, policy rejection, exact calldata validation, reduce-only, idempotency, takeover and activity evidence |
| C6.1, C6.2, C6.3, C6.4 | P4 | Browser-closed CRE evaluations, durable job state, identified gas payer, timeout/restart reconciliation and safe dependency failures |
| C7.1, C7.2, C7.3, C7.4, C7.5 | P0, P3-P5 | Real request ID, verified-or-explicitly-unverified TEE, encrypted storage round trip, restart and manual independence |
| C8.1, C8.2, C8.3, C8.4, C8.5, C8.6 | P0, P4 | Capped budget, actual compute balance/debit, confirmed replenishment, low-budget pause; earned mode only with real revenue |
| C9.1, C9.2, C9.3, C9.4, C9.5, C9.6 | P0, P3-P5 | Real CRE simulation, chain/HTTP observations, bounded proposal, authenticated execution handoff, durable runner and allow/reject evidence |
| C10.1, C10.2, C10.3, C10.4, C10.5, C10.6, C10.7 | P6 | Working sponsor flows, feedback artifacts, test-fund demo, both handoffs and safe failures |

Mandatory automated cases, using the existing test frameworks:

- Wrong user/account/network; expired or replayed login challenge; expired session; unauthorized recipient or allowance; forbidden ownership/withdrawal action.
- Zero, negative, overflow, malformed and excessive-precision amounts; wrong token decimals; slippage and deadline bounds; ambiguous position lookup.
- Model timeout or invalid output; an instruction to ignore limits; a stale quote; position already closed; concurrent owner and agent commands.
- Duplicate action ID; crash before send; timeout after send; submitted-unknown reconciliation; partial fill; cancellation racing a fill; revoked key and changed control revision.
- Two users and simultaneous budget reservations; exhausted credit; funding confirmation pending; storage upload failure; encrypted memory recovery and key isolation.
- CRE malformed output, wrong source mode/account/network, expired observation or policy revision, repeated proposal fetch without extra compute charge, duplicate result, stale/late result, paused strategy, failed internal authentication and runner timeout/restart. A simulation result must not be accepted as a production DON report.

Manual acceptance sequence:

1. Connect owner, inspect existing balances/positions, authorize agent and explicitly fund a bounded budget.
2. Make a manual spot swap; show actual Uniswap settlement and current account state.
3. Open a perpetual position manually and ask the agent to reduce it. Show the 0G request, policy result and same-account venue change.
4. Have the agent open a permitted position; manage it manually; pause/revoke agent and reject its next queued action.
5. Restart the worker, recover encrypted memory and reconcile existing orders without duplication.
6. Run an owner-approved conditional strategy through the actual CRE CLI with real onchain and external observations. Show the 0G proposal, allow decision, permission check and settled Uniswap transaction; then demonstrate a rejected candidate.
7. Show a capped compute replenishment and low-budget pause. Stop the CRE runner, show the affected automation paused, and retain manual controls. Redeliver an evaluation and prove that no second trade or compute debit occurs.

Use seeded test scenarios and controlled failures, but label simulation/fork evidence. Do not present a recording or locally generated trace ID as a live external transaction or provider receipt.

## 8. Known gates, not hidden assumptions

| Gate | Consequence if unresolved |
| --- | --- |
| 0G PC credentials, request evidence and actual funding interface | AI integration and operating-budget acceptance cannot be marked complete merely because sponsor credits exist |
| Verified private-inference mode | Do not advertise TEE-protected reasoning or route private-only requests through a weaker mode |
| Smart-account/router/network compatibility and test liquidity | Do not enable agent swaps with broad authority as a workaround; keep the checklist item blocked until a bounded route works |
| Hyperliquid existing-account modes and agent authorization | Show supported modes explicitly; do not flatten a user's account or reject all existing positions to reuse old onboarding unchanged |
| CRE authentication, toolchain, enabled network and real chain/HTTP calls | CRE acceptance remains blocked until the actual workflow drives an action/no-action/reject result; a timer or log-only script is insufficient |
| Runner authentication, freshness, idempotency and quota/latency behavior | Do not allow unattended execution from untrusted or stale workflow output, or promise continuous scheduling after the runner stops |
| Optional hosted CRE access and billing | Not required for the simulation bounty. Confirm approval, report verification and commercial terms before promising hosted or free decentralized automation |
| Public-repo licensing of copied code/assets | Confirm ownership/license before publishing, including inherited `UNLICENSED` packages and fonts |

No hard calendar estimates are assumed without team size and the results of P0. The fastest first integration proof is one real manual action followed by an agent action on the same account, with sponsor dependencies tested early. Defer cosmetic polish and extra venues before weakening authorization or dropping checklist capabilities.

## 9. Original planning baseline (2026-11-05)

- Source code and tests were inspected; exact provenance is in the reuse inventory.
- A focused test command was attempted in the original agent package and stopped with `vitest: command not found` (exit 127). No source test pass is claimed.
- No source dependencies were installed, no application code was ported, and no onchain transaction was submitted during the original planning pass. Subsequent implementation uses the isolated worktrees and commits in this repository.
- This plan is not evidence that any integration is already live. Checkboxes remain open until demonstrated in this repository.

## Implementation references

Use the official references to verify exact versions and capabilities during P0; do not turn reference prose into runtime configuration.

- [Kernel permission modules](https://docs.zerodev.app/smart-accounts/permissions/intro)
- [Hyperliquid nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)
- [Hyperliquid exchange API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)
- [Uniswap developer documentation](https://developers.uniswap.org/docs)
- [0G Compute documentation](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/overview)
- [0G Storage SDK documentation](https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk)
- [CRE overview](https://docs.chain.link/cre/overview)
- [CRE simulation and its limits](https://docs.chain.link/cre/guides/operations/simulating-workflows)
- [CRE service quotas](https://docs.chain.link/cre/service-quotas)
- [CRE network and forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory)
- [CRE deployment access](https://docs.chain.link/cre/guides/operations/deploy-access)
