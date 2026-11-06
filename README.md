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
| Uniswap | Public Sepolia RPC, generic server-side bundler and operator-funded paymaster, owner-created smart account and explicitly transferred test assets; delegation requires a bounded owner-signed session grant |
| Hyperliquid | Owner wallet and funded Hyperliquid testnet account; approve the separate agent address only if autonomous trading is wanted |
| 0G memory | Configure a funded operator Galileo signer and enable storage. The platform pays native gas/storage under per-backup and shared daily caps; users do not need 0G. Advanced agent-paid mode remains optional |
| Chainlink CRE | Official CLI, its required build toolchain, authenticated CLI access and the workflow directory; see the workflow's own setup instructions |

Wallet connection is not trading authorization. Users retain their owner wallet; the application never asks for its seed phrase or private key. Agent and owner actions target the same supported account state, including existing Hyperliquid positions. Operating funds and trading capital are separate.

Uniswap execution uses a Kernel account with bounded call, expiry and gas policies. The backend's per-trade risk checks are additional controls. Hyperliquid's native agent grant is trading authority; our custom asset and notional limits are application-enforced, not falsely advertised as venue-native restrictions.

### Trading funds and gas

- Connecting a wallet does not move funds. The initial deposit is an explicit owner-wallet transfer on Ethereum Sepolia and needs that wallet's Sepolia ETH network fee. This is not a bridge from another chain.
- Manual and agent smart-account swaps require platform-sponsored gas. A sponsor refusal stops before signing; the app does not silently charge the trading account instead. Sponsorship covers gas, not the assets being swapped.
- Native ETH input wraps exactly the reviewed amount into WETH and swaps it for USDC in the same atomic operation. An agent needs a separate, default-off native-wrap grant with a cap. Existing grants do not gain ETH transfer authority.
- Buying WETH returns WETH, not native ETH. Native ETH output, automatic unwrapping and cross-chain routes are not enabled.
- Hyperliquid uses its own testnet account, collateral and trading fees. Ethereum smart-account sponsorship is not its deposit or gas mechanism.

Our platform wallet is the primary gas funder. Set `ORCUS_GAS_SPONSOR_PROVIDER=operator` (the default), a Sepolia ERC-4337 v0.7 `BUNDLER_RPC_URL`, `ORCUS_PAYMASTER_ADDRESS` and the server-only `ORCUS_GAS_SPONSOR_PRIVATE_KEY`. Deploying the paymaster and funding its EntryPoint ETH deposit are separate operator actions. The signer approves exact, short-lived, capped operations; it is not the user's owner key or agent trading key. Keep the paymaster owner separate from its hot approval signer in production.

The existing open-source Kernel SDK and user account addresses are retained. ZeroDev's hosted infrastructure is an optional secondary, enabled only by `ORCUS_GAS_SPONSOR_PROVIDER=zerodev` plus `ZERODEV_RPC_URL` and `ZERODEV_PAYMASTER_RPC_URL`. A failed operator request never switches providers or charges the user's gas balance automatically. Browser wallet traffic uses authenticated same-origin proxies; provider endpoints and approval keys stay server-side. Normal users need neither a ZeroDev account nor native 0G for this sponsored trading path. Configuration alone does not prove a deployed, funded or bundler-accepted operation.

As checked on November 6, 2026, ZeroDev's [pricing page](https://www.zerodev.app/pricing) lists a $0 testnet-only Sandbox with 10,000 monthly credits, 20 credits per bundled operation, and a $69/month Launch plan. The table also lists an 8% gas-sponsorship premium without making its testnet billing treatment clear. Do not assume unlimited free sponsorship. These hosted-service terms do not apply to our operator paymaster, although its underlying Sepolia ETH and bundler infrastructure still need funding/configuration.

## Personal agent and automation

The agent uses LangGraph with bounded reasoning and registered tools for real market reads, portfolio inspection, indicators and typed trade/schedule proposals. Signing remains outside the model. Approval-required chat proposals use the owner signing path; autonomous actions require the current account grant. Interactive chat and unattended strategies have separate tool profiles, enforced before exposing tools and again before invocation.

Per-user SQLite memory supports full-text retrieval, explicit preferences, execution episodes, forgetting and durable checkpoints. Encrypted 0G backups include this state; old encrypted backups are not erased when a local note is forgotten. Checkpoints and request IDs prevent a retry from silently repeating a possibly billable model call.

The automation screen supports agent-planned strategies, exact recurring trade requests and read-only price alerts. Chat can propose a schedule, but the owner must review and activate it. Alerts require no trading grant, never create trades and notify on a new threshold crossing instead of every evaluation. Actual CRE CLI evaluation remains required; there is no simulated-success fallback.

An operating-wallet transfer is not a compute deposit. Capped replenishment has an owner-approved policy, exact Router beneficiary, Galileo network binding, gas allowance, idempotent intents, receipt recovery and a Router synchronization gate. It stays disabled until a fresh management-key balance verifies the matching testnet 0G-mode account. Production Router 16661 credits cannot be replenished through Galileo 16602 deposits. The app never silently funds compute from trading capital.

`node --import tsx scripts/verify-compute-funding-fork.ts` exercises the existing deployed Galileo PaymentVault in isolated Anvil with generated wallets and synthetic local funds, including durable signed-intent recovery after reopening SQLite. It performs no public write or deployment. Its management-read input is explicitly a test fixture; a successful vault deposit remains `awaiting-router-sync` and is not advertised as spendable Router credits.

Inference records the actual Router request, native billing currency and USD-equivalent expense separately. Uncertain costs retain their reservation. Price filters bound provider selection; token accounting still depends on provider/template behavior. Optional earned funding is not enabled or claimed: owner deposits and sponsor credits are not revenue.

Operator-paid inference also has independent server-enforced UTC-day ceilings: `ORCUS_COMPUTE_USER_DAILY_USD=1` per user and `ORCUS_COMPUTE_PROJECT_DAILY_USD=10` across the project by default. The operator can adjust these exact six-decimal USD-equivalent limits; zero stops new reservations. They apply even when checkout is disabled and are not raised by an owner changing the expense cap or adding test credits. Reservations are atomic across users, unknown costs remain held across midnight, actual settled costs count on their server-recorded settlement day, and rejected requests release their reservation. Exhaustion stops the next provider call rather than consuming unbounded shared Router credits.

Encrypted backups have explicit per-request native gas and storage-fee caps. The operating signer allows one bounded Galileo Flow transaction, persists its hash before broadcast and records receipt-confirmed costs separately from the USD inference allowance. An unknown write blocks another backup until receipt reconciliation. A paid transaction alone is not labelled a successful backup: finalized object availability must also be confirmed.

Operator-paid storage uses `ZEROG_STORAGE_PAYER=operator` and a server-only sponsor signer. A payer-wide nonce lock and UTC-day native cap cover all users; one user cannot bypass a pending transfer by starting another account. Requests cannot raise the operator's fee ceilings. Users keep separate trading and agent operating accounts but do not have to fund those accounts with 0G for inference or sponsored storage. Native costs are metered here, not converted into a fabricated USD charge.

The separate service checkout is disabled by default. Set `ORCUS_SERVICE_PAYMENT_MODE=testnet` and the operator's `ORCUS_SERVICE_PAYMENT_TREASURY` to accept exact owner-approved Sepolia USDC transfers. Verified receipts grant test-only service credits at a fixed one-USDC-to-one-USD-equivalent rate. Neither test USDC nor these credits has monetary value. The Settings panel shows paid, spent, reserved, released and remaining credits; owner expense caps remain a separate control and cannot mint credits. Live payment collection is unsupported.

Wallet flows verify token balance, simulate the transfer, check Sepolia ETH for a bounded fee envelope and persist a pending intent before opening the wallet. A payment requires two confirmations and one exact Transfer event from the named owner to the immutable treasury. Global event uniqueness and SQLite transactions prevent duplicate credits across retries or restarts. Quote expiry blocks starting a new wallet flow, not recovery of an otherwise valid successful transfer; delayed or dismissed transfers remain claimable once. Unknown inference billing stays reserved, and released reservations are not token refunds. `node --env-file-if-exists=.env --import tsx scripts/verify-service-payment-fork.ts` verifies an actual existing Circle USDC transfer on an isolated Sepolia fork without public writes or deployment.

Trading principal, collateral and venue/network fees remain separate. Uniswap smart-account execution is disabled until Ethereum gas sponsorship is configured and approved for the operation; backend 0G sponsorship does not make every trade gasless. An unavailable sponsor does not revoke existing onchain session authority. Pause new agent actions and use an explicitly reviewed owner recovery transaction if native revocation is unavailable.

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

The fork verifier needs Anvil and Sepolia RPC access. Its pinned historical block needs an archival source; use `ORCUS_FORK_SOURCE_RPC` for one or explicitly select a retained block with `ORCUS_FORK_BLOCK`. It performs real local-fork swaps with ephemeral accounts, not public transactions. After installing the separate CRE workflow dependencies, `npm run test:cre` runs its three capability-fixture tests. To intentionally spend a small amount of compute credits against a running local app:

```sh
npm run verify:compute -- --allow-paid-inference --gateway-reported-private
```

Add `--extended` to verify real market reads, candle analysis, typed order/alert drafts, memory recall, duplicate-request billing and budget-stop behavior. It never activates a strategy or executes a trade.

Storage verification defaults to a read-only fee quote:

```sh
npm run verify:storage
```

A funded upload/download additionally requires `--allow-testnet-storage-fees`, `--expected-payer=<approved address>` and `--expected-flow=<approved Flow address>`. Obtain operator approval before using those flags. The verifier caps gas at 0.003 0G and storage fees at 0.01 0G, uses platform sponsorship for an unfunded synthetic user, reopens the database and restores the actual encrypted backup. It does not deploy a contract. Storage remains disabled by default; the funded test enables it only inside its own process.

Hyperliquid verification defaults to read-only account inspection:

```sh
npm run verify:hyperliquid -- --expected-owner=0x17A076d6cCaf37Bc9386EAB653A5EfAd8B07430C
```

The separately approved testnet-write mode additionally requires `--allow-testnet-trades`, explicit `--max-notional-usdc` (at most 20) and `--max-fees-usdc` (at most 1). It refuses pre-existing positions/orders, verifies the dedicated local test signer matches the exact expected owner, preserves existing agents and creates a fresh short-lived agent. One owner-opened ETH position is managed and closed by that agent, with owner cancellation of an agent's protective order. Public-only runtime evidence is saved before sends; unresolved runs block another opening. This is a dedicated test-wallet verifier, not an owner-private-key onboarding flow for customers.

The November 6 approved test passed with a 19.84522 mock-USDC position and 0.017865 mock-USDC total fees. It ended flat with no open orders, revoked only the fresh test agent and retained the existing named agent. See the [dated execution evidence](docs/research/verification-2026-11-06.md). Browser extension interaction and mainnet execution are not claimed by this SDK-based proof.

For functional browser acceptance, start a separate local app with an isolated `ORCUS_DATA_DIR` and no inference credentials, then run `npm run verify:browser -- http://localhost:3124`. The verifier requires Chromium (or `CHROMIUM_PATH`) and a loopback URL. It uses disposable injected-wallet signing against the actual local HTTP/SQLite implementation, checks rejection, account-role separation, pause/resume, expired automation and owner-switch races, and permits no trade signatures or inference calls. It is not a real extension, funded-trading or deployment certification.

Use `ORCUS_VERIFY_APP_URL=http://localhost:3100` when the app runs on another port. This creates an unfunded synthetic owner, verifies inference, saved preferences, request IDs and settled billing, and never submits trades. The generated test owner has no retained signing key; its test records remain in local application data.

`doctor` checks configuration and performs read-only market requests. It does not submit transactions, upload storage objects or spend inference credits. An installed SDK or configured endpoint is not evidence of live authorization or successful execution.

The checklist remains the end-to-end acceptance record. Code implementation, local compile checks, public read connectivity and a funded owner-signed live demonstration are distinct milestones. Missing credentials and disabled integrations are surfaced instead of replaced with fabricated balances, fills or workflow results.

The dependency audit still reports upstream findings, including transitive storage-SDK and WebSocket dependencies. These need compatibility and exposure review before production or real-fund use; passing application tests is not a clean dependency-security audit.

## Boundaries

- Trading and storage writes use Sepolia, Hyperliquid testnet and Galileo only. The provided compute credits use the production Router; that does not authorize production-chain payments. Testnet pool prices are not live-market valuations.
- CRE starts as actual local CLI simulation, orchestrated by our worker. It is not hosted DON execution and stops when its runner stops.
- No anonymous-read or private-trade claim. Private inference records its exact assurance level; persistent memory is encrypted before upload.
- An operating expense cap is not a funded compute balance. Credit-balance and replenishment capabilities must be verified against the actual provider. No automatic top-up or earned-revenue loop is claimed without that evidence.
- There is no token launch, pooled trading vault or requirement to close all existing positions before connecting.
