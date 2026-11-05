# Hackathon Implementation Plan

Date: 2026-11-05
Status: implementation-ready plan; application code has not been ported or verified in this repository.

## 1. Product and fixed scope

Build a personal-agent trading platform. A user connects their wallet, authorizes their own agent, and can research, trade, automate and manage the same supported accounts through either the interface or conversation. The agent has its own operating wallet and separate, restricted trading credentials. The user's private key never leaves their wallet.

The [product checklist](../specs/product-checklist.md) contains all 57 acceptance items. None is removed by this plan. The passes below are execution order within the hackathon, not a sequence of future product releases. Optional earned funding remains optional exactly as in the checklist.

| Integration | Actual product responsibility | What we must demonstrate |
| --- | --- | --- |
| 0G | AI research and planning; encrypted persistent memory; compute expenditure and authorized replenishment | Real inference request IDs, a useful action plan, restored memory and actual compute-account spending |
| Uniswap | Spot swaps from a user-owned account, initiated manually or by a scoped agent | Real quote, permission checks, transaction and settled token changes |
| Ethereum Foundation Anon-RPC | Anonymized supported browser EVM reads | A real anonymizing worker, successful balance/allowance/contract reads and honest failure/coverage status |
| Hyperliquid | Perpetual trading and management of existing user positions | Native owner approval of an agent, manual and agent actions on the same trading account |

The first three are sponsor targets. Hyperliquid is a venue, not another sponsor. Anon-RPC does not anonymize trades, Hyperliquid APIs or all backend traffic. Private inference is a separately verified capability, not a claim inferred from a function name.

Do not add a token, pooled trading vault, Arkiv, Hedera, an INR rail or a shielded-trading claim to complete this scope. Preserve an adapter boundary for more venues without implementing every venue now.

## 2. Reuse decision

Use the existing application as the foundation, selected Hyperliquid execution components as the venue implementation, and selected terminal components for the interface. Do not merge three entire products.

Exact original paths, revisions and known problems belong in the [reuse inventory](../research/reuse-inventory.md). Implementation tasks below refer to its reuse IDs so source provenance does not become product configuration or leak into UI copy.

| Reuse IDs | Bring over and adapt | Do not bring over |
| --- | --- | --- |
| R01-R05 | Next.js shell, wallet connection, strategy validation, indicators, compute/storage boundaries, receipt UI and fork-test patterns | Shared-agent vault ownership, dark-pool assumptions, forced-execution prompts, fake persistence success, unrelated chain integrations |
| R06-R10 | Native Hyperliquid approval, encrypted agent-key handling, exact order formatting, durable submission/reconciliation patterns and quoting | Flat-account onboarding, exclusive-agent requirement, fixed two-leg IOC execution, protocol-wide solver/keeper machinery |
| R11-R12 | Chart, order-ticket, order-book, position-management and activity presentation | RWA lifecycle semantics, old market manifests, app-specific backend contracts and unrelated dashboard modules |

Port the smallest working dependency closure, including relevant tests. Adapt imports and domain types locally. Do not preserve old package names merely to make a large import graph compile.

## 3. Small target structure

Use npm consistently. Keep the working framework versions from the selected base initially; resolve actual compatibility conflicts individually. Do not combine lockfiles from different package managers or install every dependency used by the source products.

```text
web/                         Next.js interface and authenticated HTTP routes
  src/app/                   Trading, agent settings and activity screens
  src/components/trading/    Chart, order ticket, positions and orders
  src/components/agent/      Chat, action preview, permissions and budget
  src/lib/wallets/            Owner signing and venue authorization
  src/lib/privacy/            Browser Anon-RPC transport and status
  src/server/                Session auth and account-scoped API handlers
agent/                       Durable worker and protected signing service
  src/compute/               0G inference adapter and evidence
  src/storage/               Encrypted memory upload and recovery
  src/execution/             Policy validation, leases, journal, reconciliation
  src/venues/uniswap/        Quotes, bounded calls and settlement checks
  src/venues/hyperliquid/    Account state, orders, approval and reconciliation
  src/automation/            Schedules, monitoring, alerts and retries
  src/budget/                Operating ledger and compute replenishment
packages/core/               Shared validated plans, money types and states
packages/server/             Database, migrations, auth and keystore helpers
contracts/                   Existing Hardhat test harness; bounded executor only if needed
docs/specs/                 Product acceptance checklist
docs/plans/                 Implementation sequence
docs/research/              Reference-only reuse evidence
```

These are planned destinations, not existing implementations. Keep two long-running application processes: web and worker. Do not split each adapter into a new deployed service. Shared packages must not introduce a circular dependency between web and worker.

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

### Ownership and takeover rules

- Connecting a wallet enables reads. A signed, one-time login challenge establishes the authenticated user. Venue delegation is a separate explicit signature.
- Owner-only operations include permission changes, withdrawals, operating-budget changes and authorizing automation.
- Keep agent credentials out of prompts, browser responses, logs, memory snapshots and public storage. Do not port a legacy plaintext-key fallback.
- Pause Agent stops future queued actions and releases scheduling authority. Take Over also invalidates stale planned actions by incrementing an account control revision.
- An in-flight signed order or transaction cannot always be stopped. Show it as reconciling and query the venue before retrying or reporting takeover complete.
- Local leases cannot lock someone out of trading through another app. Detect changed balances, positions and orders and re-plan or pause rather than promising global atomic control.
- Revoking automation must not prevent the owner from closing positions or withdrawing through the venue. Previously placed protective orders must be handled explicitly, not silently removed.

## 5. One execution pipeline for both interfaces

```text
Manual order ticket OR agent conversation/automation
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
| Automation jobs | Conditions, schedule, state, retry budget and next evaluation |
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
- Probe one real Anon-RPC worker against target RPCs, including cold-start latency. Establish reliable gateway access before building a UI that depends on it.
- Verify the EVM test environment: Sepolia is the first candidate, not a promised deployment. Require supported smart-account infrastructure, correctly identified Uniswap contracts and usable test liquidity. Use a fork for repeatable tests; a local fork is not automatically a judge-accessible live venue.
- Verify Hyperliquid testnet access, funding and supported account mode with a dedicated test owner. Do not submit a real order using someone else's account or mainnet funds.

Exit: base builds, copied unit tests run, and a short compatibility table records what works and what is blocked. No provider, TEE or chain-support claim is inferred merely from successful TypeScript compilation.

### P1. Establish owner, accounts, storage and signing boundaries

- Add wallet-signed login with nonce/expiry/domain binding; validate server-side and prevent replay. Authorize every mutable route against its user/account, not a supplied wallet address alone.
- Create the per-user agent, operating wallet and account records. Display their separate addresses.
- Implement encrypted credentials using R06/R07, without legacy plaintext import. Keep key material outside the repo, restrict file permissions and redact logs.
- Add smart-account owner/session setup and native Hyperliquid agent approval. Read imported positions before enabling automation.
- Implement permissions review, revocation, rotation, control revisions and account leases.

Exit: two users cannot access each other's records, signers or budgets; connecting alone cannot trade; revoked/expired agent authority blocks new agent actions while owner controls remain available.

### P2. Ship the real manual execution spine

- Implement the common plan, policy, journal and reconciliation interfaces before attaching chat.
- Bring over R05/R08/R09/R10 as small adapters. Preserve integer-based amount and precision handling.
- Implement Uniswap quote, bounded allowance, manual owner execution and settlement display.
- Implement Hyperliquid manual open, cancel, reduce, close and supported TP/SL flows, including partial fills and pre-existing positions.
- Route supported browser EVM reads through the already-proven Anon-RPC transport. Keep privacy status explicit from the first integrated screen.
- Use a minimal working trading screen now; adapt R11/R12 presentation as the underlying actions become real. Do not wait for a polished terminal to test settlement.

Exit: the owner can trade and manage real test accounts with 0G inference disabled. No fabricated positions, fake fills or stale balance shown as live.

### P3. Attach the full personal agent and prove handoff

- Use 0G to produce validated, meaningful action plans from user intent and retrieved context. Reuse indicators for observations and hard checks, not as a substitute for the planned AI workflow.
- Replace forced-execution prompt shortcuts and permissive parse fallbacks. Invalid JSON, unsupported assets or ambiguous instructions must produce an error or clarification, never an unconditional trade.
- Add research/read-only tools, explanations, quotes, swaps, order changes, position management and schedule creation through the shared pipeline.
- Support explicit confirmation and policy-authorized autonomous mode. An LLM assertion that the user approved is never authorization.
- Add in-product request evidence and actual execution history without exposing private prompts or keys.
- Prove manual-open then agent-reduce/close, agent-open then manual-manage, and import an existing supported position opened through another interface.

Exit: the agent controls the same account state as the user; takeover and ambiguity behave safely; manual features still work when inference is unavailable.

### P4. Complete automation, memory and operating budget

- Run scheduled monitoring, DCA, alerts and authorized strategies from the durable worker. Persist job states and next evaluation time.
- On startup, reconcile uncertain submissions before resuming jobs. Add bounded retries, stale-data checks and safe pause on expired permissions.
- Encrypt memory before upload, confirm persistence, store the versioned reference, and restore after restart. Preserve upload failures as failures with retriable work, not imaginary stored receipts.
- Show compute balance, owner-funded budget, actual consumption and replenishment separately. Serialize spending reservations so concurrent requests cannot both consume the same remaining budget.
- Use the real funding path proven in P0. Restrict replenishment to approved destination/account and caps; wait for funding confirmation before treating it as spendable compute.
- Surface low balance, exhausted credits, funding pending/failed and storage failure. Pause new autonomous risk when needed without disabling manual exits or pretending protective orders disappeared.
- If genuine earned funding is enabled: sell an actual opted-in service, record payment, route its authorized revenue to compute, and show the next inference consuming it. No token, fabricated customer, self-trading revenue or assumption of profitable trading. If that loop is not demonstrated, call the feature budgeted/self-paying, not self-sustaining, and do not enter that extra bounty.

Exit: browser-closed operation and restart recovery work; memory returns; actual compute debits and a capped replenishment are evidenced; low budget does not trigger unauthorized capital transfers.

### P5. Finish the unified interface and privacy demonstration

- Adapt R11/R12 into one terminal: instrument selector, chart, order ticket, balances, positions, orders, activity, agent chat and settings.
- Present spot holdings separately from leveraged positions. Use real venue feeds and mark missing/stale prices. Do not reuse a fixture-backed P&L calculation as live performance.
- Give every order a clear preview, signing/pending/filled/error state and initiator. Add permission expiry, Pause Agent, Take Over and operating-cost panels.
- Validate Anon-RPC balance, allowance, quote-compatible contract calls and supported position reads under actual demo connectivity. Show bootstrap time, latency and routing failures.
- On anonymizing transport failure, stop claiming private reads. Default to a visible unavailable state. If an owner deliberately chooses direct reads, label the mode and coverage change explicitly.
- Document uncovered backend, wallet, indexer, Uniswap REST and Hyperliquid traffic. Do not reuse a normal HTTP fallback transport behind a private badge.
- Verify private-inference configuration and attestation independently. If unavailable, leave TEE protection unverified and clearly mark which privacy protections actually work; do not silently downgrade a request explicitly requiring private inference.

Exit: UI reflects actual backend/venue state, private-read coverage is measured and the demonstration works without hidden manual fixes.

### P6. Verify, package and rehearse

- Complete the acceptance matrix below with evidence. Leave any unverified requirement unchecked and identify the specific blocker.
- Run selected unit/integration suites, contract/fork tests, typecheck and builds. Report conditional fork-test skips separately from passes.
- Rehearse a short live flow using test funds and record the three-minute video. Include the same-account handoff, 0G request evidence and real anonymized reads.
- Add setup, architecture, environment-variable names, account/network assumptions and limitations to the README. Include actual deployment addresses only after verifying them.
- Complete `FEEDBACK.md` and the Uniswap developer feedback form. Document 0G integration observations and EF traffic coverage.
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
| C6.1, C6.2, C6.3, C6.4 | P4 | Browser-closed jobs, durable states, identified gas payer, timeout/restart reconciliation and dependency failure handling |
| C7.1, C7.2, C7.3, C7.4, C7.5 | P0, P3-P5 | Real request ID, verified-or-explicitly-unverified TEE, encrypted storage round trip, restart and manual independence |
| C8.1, C8.2, C8.3, C8.4, C8.5, C8.6 | P0, P4 | Capped budget, actual compute balance/debit, confirmed replenishment, low-budget pause; earned mode only with real revenue |
| C9.1, C9.2, C9.3, C9.4, C9.5, C9.6 | P0, P2, P5 | Real worker/gateway, representative reads, latency/error display, no silent direct fallback and documented limits |
| C10.1, C10.2, C10.3, C10.4, C10.5, C10.6, C10.7 | P6 | Working sponsor flows, feedback artifacts, test-fund demo, both handoffs and safe failures |

Mandatory automated cases, using the existing test frameworks:

- Wrong user/account/network; expired or replayed login challenge; expired session; unauthorized recipient or allowance; forbidden ownership/withdrawal action.
- Zero, negative, overflow, malformed and excessive-precision amounts; wrong token decimals; slippage and deadline bounds; ambiguous position lookup.
- Model timeout or invalid output; an instruction to ignore limits; a stale quote; position already closed; concurrent owner and agent commands.
- Duplicate action ID; crash before send; timeout after send; submitted-unknown reconciliation; partial fill; cancellation racing a fill; revoked key and changed control revision.
- Two users and simultaneous budget reservations; exhausted credit; funding confirmation pending; storage upload failure; encrypted memory recovery and key isolation.
- Anonymizing-worker bootstrap/failure; normal passthrough accidentally configured; direct fallback disabled; private status cleared when coverage is unavailable.

Manual acceptance sequence:

1. Connect owner, inspect existing balances/positions, authorize agent and explicitly fund a bounded budget.
2. Make a manual spot swap; show actual Uniswap settlement and anonymized browser account reads.
3. Open a perpetual position manually and ask the agent to reduce it. Show the 0G request, policy result and same-account venue change.
4. Have the agent open a permitted position; manage it manually; pause/revoke agent and reject its next queued action.
5. Restart the worker, recover encrypted memory and reconcile existing orders without duplication.
6. Show a capped compute replenishment, a low-budget stop and an unavailable privacy route with honest UI states.

Use seeded test scenarios and controlled failures, but label simulation/fork evidence. Do not present a recording or locally generated trace ID as a live external transaction or provider receipt.

## 8. Known gates, not hidden assumptions

| Gate | Consequence if unresolved |
| --- | --- |
| 0G PC credentials, request evidence and actual funding interface | AI integration and operating-budget acceptance cannot be marked complete merely because sponsor credits exist |
| Verified private-inference mode | Do not advertise TEE-protected reasoning or route private-only requests through a weaker mode |
| Smart-account/router/network compatibility and test liquidity | Do not enable agent swaps with broad authority as a workaround; keep the checklist item blocked until a bounded route works |
| Hyperliquid existing-account modes and agent authorization | Show supported modes explicitly; do not flatten a user's account or reject all existing positions to reuse old onboarding unchanged |
| Reliable anonymizing worker/gateway | EF demo and default private reads remain blocked; do not silently swap to direct HTTP |
| Public-repo licensing of copied code/assets | Confirm ownership/license before publishing, including inherited `UNLICENSED` packages and fonts |

No hard calendar estimates are assumed without team size and the results of P0. The fastest first integration proof is one real manual action followed by an agent action on the same account, with sponsor dependencies tested early. Defer cosmetic polish and extra venues before weakening authorization or dropping checklist capabilities.

## 9. Inspection and execution status

- Source code and tests were inspected; exact provenance is in the reuse inventory.
- A focused test command was attempted in the original agent package and stopped with `vitest: command not found` (exit 127). No source test pass is claimed.
- No source dependencies were installed, no application code was ported, and no onchain transaction was submitted during planning.
- This plan is not evidence that any integration is already live. Checkboxes remain open until demonstrated in this repository.

## Implementation references

Use the official references to verify exact versions and capabilities during P0; do not turn reference prose into runtime configuration.

- [Kernel permission modules](https://docs.zerodev.app/smart-accounts/permissions/intro)
- [Hyperliquid nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)
- [Hyperliquid exchange API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)
- [Uniswap developer documentation](https://developers.uniswap.org/docs)
- [0G Compute documentation](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/overview)
- [0G Storage SDK documentation](https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk)
- [Anon-RPC wallet integration](https://ethereum.github.io/anon-rpc/wallets/)
- [Tor gateway implementation](https://github.com/ethereum/tor-js/tree/main/crates/tor-js-gateway)
