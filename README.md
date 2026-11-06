# Orcus ETHGlobal

A personal-agent trading platform where users and authorized agents manage the same supported trading accounts. Manual controls and agent capabilities share execution, permissions and position state. Users never share their wallet private keys.

Sponsor targets: 0G inference and encrypted memory, Uniswap spot execution, and Chainlink CRE for conditional strategy orchestration. Hyperliquid supplies an additional trading venue. CRE starts in local simulation with real testnet/API calls and a managed runner; this is not hosted DON execution.

## Project documentation

- [Implementation plan](docs/plans/implementation-plan.md): architecture, reuse decisions, build order, dependency gates and acceptance tests.
- [Product checklist](docs/specs/product-checklist.md): 57 current acceptance items, including the replacement CRE requirements.
- [Reuse inventory](docs/research/reuse-inventory.md): inspected source paths and revisions, adaptations, known hazards and baseline-test results.
- [Verified flows and remaining gates](docs/research/verification-2026-11-06.md): real inference, billing and isolated-fork receipts.

## Local development

Requires Node 22.16 or later and npm. Install dependencies, copy `.env.example` to a local `.env`, then run:

```sh
npm install
npm run dev
```

Open `http://localhost:3000`. Root commands load the root `.env`; do not put secrets in source code or public environment variables.

In a second terminal, run the persistent automation worker after setting the same `ORCUS_INTERNAL_TOKEN` for both processes:

```sh
npm run worker
```

For a production-style local run:

```sh
npm run build
npm start
```

Set `ORCUS_MASTER_KEY` before starting in production. Development creates an owner-only local encryption key. Database and encrypted credentials live outside the checkout by default under the OS user's local application data directory. Back up the encryption key and database together; replacing that key does not recover existing encrypted signers.

## What each integration needs

| Integration | Configuration and user action |
| --- | --- |
| 0G inference | Exact chat-completions URL, API key and model from your credited account; authorize an operating expense cap in settings. Router balance additionally needs a management key scoped to `account:read` |
| Uniswap | Public Sepolia RPC, server-side `ZERODEV_RPC_URL`, owner-created smart account, explicitly transferred test tokens and gas; delegation requires a bounded owner-signed session grant |
| Hyperliquid | Owner wallet and funded Hyperliquid testnet account; approve the separate agent address only if autonomous trading is wanted |
| 0G memory | Enable storage and explicitly fund the separate operating address with Galileo test tokens using the owner-signed funding control before requesting an encrypted upload |
| Chainlink CRE | Official CLI, its required build toolchain, authenticated CLI access and the workflow directory; see the workflow's own setup instructions |

Wallet connection is not trading authorization. Users retain their owner wallet; the application never asks for its seed phrase or private key. Agent and owner actions target the same supported account state, including existing Hyperliquid positions. Operating funds and trading capital are separate.

Uniswap execution uses a Kernel account with bounded call, expiry and gas policies. The backend's per-trade risk checks are additional controls. Hyperliquid's native agent grant is trading authority; our custom asset and notional limits are application-enforced, not falsely advertised as venue-native restrictions.

## Personal agent and automation

The agent uses LangGraph with bounded reasoning and registered tools for real market reads, portfolio inspection, indicators and typed trade/schedule proposals. Signing remains outside the model. Approval-required chat proposals use the owner signing path; autonomous actions require the current account grant. Interactive chat and unattended strategies have separate tool profiles, enforced before exposing tools and again before invocation.

Per-user SQLite memory supports full-text retrieval, explicit preferences, execution episodes, forgetting and durable checkpoints. Encrypted 0G backups include this state; old encrypted backups are not erased when a local note is forgotten. Checkpoints and request IDs prevent a retry from silently repeating a possibly billable model call.

The automation screen supports agent-planned strategies, exact recurring trade requests and read-only price alerts. Chat can propose a schedule, but the owner must review and activate it. Alerts require no trading grant, never create trades and notify on a new threshold crossing instead of every evaluation. Actual CRE CLI evaluation remains required; there is no simulated-success fallback.

An operating-wallet transfer is not a compute deposit. Capped replenishment has an owner-approved policy, exact Router beneficiary, Galileo network binding, gas allowance, idempotent intents, receipt recovery and a Router synchronization gate. It stays disabled until a fresh management-key balance verifies the matching testnet 0G-mode account. Production Router 16661 credits cannot be replenished through Galileo 16602 deposits. The app never silently funds compute from trading capital.

Inference records the actual Router request, native billing currency and USD-equivalent expense separately. Uncertain costs retain their reservation. Price filters bound provider selection; token accounting still depends on provider/template behavior. Optional earned funding is not enabled or claimed: owner deposits and sponsor credits are not revenue.

Encrypted backups have explicit per-request native gas and storage-fee caps. The operating signer allows one bounded Galileo Flow transaction, persists its hash before broadcast and records receipt-confirmed costs separately from the USD inference allowance. An unknown write blocks another backup until receipt reconciliation. A paid transaction alone is not labelled a successful backup: finalized object availability must also be confirmed.

Private inference is an explicit owner setting. Independent mode runs the official `pcverify` verifier, checks measured code and hardware, and pins the gateway certificate. Missing evidence stops the request. A separate opt-in gateway-reported mode routes only to the sealed private tier and records its evidence without labelling it independently attested. Neither mode hides public trades.

## Reusing existing products

Upstream product and official-verifier clones live in the ignored `inspiration/` directory. They are also excluded from server output traces. Imported modules must live in this repository, preserve applicable license notices and never depend on a local ignored checkout at runtime. See the reuse inventory for source revisions, candidate modules and adaptation constraints.

## Verification

```sh
npm run doctor
npm run typecheck
npm test
npm run verify:uniswap-fork
npm run verify:kernel-fork
```

The fork verifier needs Anvil and public Sepolia RPC access. It performs real local-fork swaps with ephemeral accounts, not public transactions. To intentionally spend a small amount of compute credits against a running local app:

```sh
npm run verify:compute -- --allow-paid-inference --gateway-reported-private
```

Use `ORCUS_VERIFY_APP_URL=http://localhost:3100` when the app runs on another port. This creates an unfunded synthetic owner, verifies inference, saved preferences, request IDs and settled billing, and never submits trades. The generated test owner has no retained signing key; its test records remain in local application data.

`doctor` checks configuration and performs read-only market requests. It does not submit transactions, upload storage objects or spend inference credits. An installed SDK or configured endpoint is not evidence of live authorization or successful execution.

The checklist remains the end-to-end acceptance record. Code implementation, local compile checks, public read connectivity and a funded owner-signed live demonstration are distinct milestones. Missing credentials and disabled integrations are surfaced instead of replaced with fabricated balances, fills or workflow results.

## Boundaries

- Trading and storage writes use Sepolia, Hyperliquid testnet and Galileo only. The provided compute credits use the production Router; that does not authorize production-chain payments. Testnet pool prices are not live-market valuations.
- CRE starts as actual local CLI simulation, orchestrated by our worker. It is not hosted DON execution and stops when its runner stops.
- No anonymous-read or private-trade claim. Private inference records its exact assurance level; persistent memory is encrypted before upload.
- An operating expense cap is not a funded compute balance. Credit-balance and replenishment capabilities must be verified against the actual provider. No automatic top-up or earned-revenue loop is claimed without that evidence.
- There is no token launch, pooled trading vault or requirement to close all existing positions before connecting.
