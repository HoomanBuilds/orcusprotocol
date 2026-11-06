# Local verification, 2026-11-06

This is execution evidence, not deployment configuration. Initial trading verification used local forks only. Later, separately authorized Galileo storage and capped Hyperliquid testnet handoff tests submitted the public testnet actions recorded below. No token launch, mainnet trade or public contract deployment was performed. Local Uniswap fork hashes are not public explorer receipts.

## Current evidence summary

The sections below preserve earlier passes on this date rather than presenting them as a fresh repeat of every integration. Current independent root acceptance includes five actual authenticated CRE simulations with real Sepolia/HTTP observations, a durable worker alert with no duplicate, seven production-build Chromium cases using injected wallets, and an operator-paymaster fork with six successful operations and nine denials. No hosted DON execution, canonical external bundler admission, real extension or public contract deployment is claimed.

The latest real 0G application recheck failed on its first upstream HTTP 502. Its ledger held an unverified 0.010000 USD-equivalent expense at failure; no retry or new cold-restart proof followed. The temporary evidence database was subsequently lost after the laptop reboot, not reconciled or proved free. Earlier successful real inference and storage evidence remains valid only within its recorded scope. See the final sections for the failure and data-loss boundaries.

## Automated verification

The post-reboot serial verification baseline is source `df9428f`, including the unknown-billing recovery control and the fix for billed HTTP error responses. The root verification pass completed the checks below under user systemd scopes capped at MemoryHigh=3G, MemoryMax=4G, MemorySwapMax=512M and CPUQuota=200%. Interrupted pre-reboot commands are not counted.

| Check | Result |
| --- | --- |
| Workspace application tests | 643 passed: web 98, engine 208, core 10, server 230, wallets 97 |
| All workspace TypeScript checks | Passed |
| Next.js Turbopack production build | Passed, with static-build CPU count limited to two |
| Separate CRE capability fixtures | 9 passed; these are not additional live CLI simulations |
| Contract compilation and paymaster helpers | 40 passed |
| Verification-script helpers | 9 passed |
| Strict verification-script TypeScript checks | Passed |
| Separate workflow TypeScript and WASM build | Passed |

Focused helper/contract commands overlap some workspace coverage; their counts must not be added to 643 as unique tests. The earlier 340-test and 404-test snapshots are historical, not the current baseline. These source-anchored results do not automatically certify later interface edits or current external-provider availability.

The documentation-only closeout reconfirmed root full and production-only npm audits at zero known findings and the exact separate `workflows/cre/strategy` lockfile at two high findings. All 29 tracked Markdown files had valid local file links. The checklist contains 57 unique IDs, all present in the plan: 53 checked, with `C8.5`, `C9.6`, `C10.1` and `C10.2` intentionally open. Six existing production output-trace manifests contained 1,537 file references and no environment, secret/key, SQLite, ignored inspiration or Git paths. Tracked-path and narrow credential-pattern checks found no forbidden credential/runtime files; this is not a comprehensive secret-history audit. No new build, test suite, browser, payment, storage write or inference was run during this documentation pass.

Compatibility fixes resolved the root dependency graph's known npm audit findings; full and production-only root audits report zero. The separate CRE workflow graph still reports two high upstream SDK-transitive findings from [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), affecting its nested zod and the dependent CRE SDK. A proposed zod override broke the SDK's `z.function().args` runtime and actual WASM execution, so it was not retained; preserving a working official SDK is not a claim that those findings are resolved. Root audit results do not cover the separate workflow lockfile. This limitation requires a compatible upstream fix or validated migration before production, and neither functional tests nor dependency scans are formal security certification.

## Earlier real 0G application flow

`ORCUS_VERIFY_APP_URL=http://localhost:3100 npm run verify:compute -- --allow-paid-inference --gateway-reported-private` passed against the running application:

- A generated, unfunded owner signed the authentication challenge. No owner private key was sent to the server.
- The personal LangGraph agent stored a requested preference and produced its explanation using two actual0G model calls.
- Router request IDs: `6fddeccc-9100-4287-b073-476ac4e2fcb1` and `832fb801-2c2c-41fe-9537-7bebcfef93c1`.
- Both costs settled. Total USD-equivalent charge: `0.000205`; reserved expense: `0.000000`. Native billing currency was 0g, not a USD wallet debit.
- The sealed private tier returned provider/request evidence. The reported assurance is `gateway-reported-private`, not independent hardware/code attestation.
- The saved preference and completed checkpoint were recovered by a separate process opening the application database.

The opt-in verifier never submits a trade. Its test owner is ephemeral; local test records remain in application data. The actual API credential is kept only in the ignored root `.env` with mode 0600 and was checked absent from tracked files.

## Actual Uniswap and Kernel fork execution

`ANVIL_PATH=/home/shreyas/.foundry/bin/anvil npm run verify:kernel-fork` passed against existing Sepolia contracts at fork block 12074104. All four operations emitted successful EntryPoint `UserOperationEvent` results. The application reconciler also verified the swap token transfers.

| Step | Local transaction hash |
| --- | --- |
| Owner wraps WETH in the owner-created Kernel account | `0x929451b9d2ff5f206fb6c72c2df8072094bcef1b984f5e88459f0813028e628f` |
| Owner swaps | `0x3b9e71ded33e7d24813995084886d405bf02c4e9bc5326007ae69ea8a52e5f34` |
| Owner-enrolled agent swaps in the same account | `0x68bce5f3867bad2b5de35e9a406bab5f59596d4558ab6f19637bd1d2d4b9c45e` |
| Owner manages the agent-acquired holdings | `0xa1a64c047217fcc11dc5689dc181203fb4a61514d945ec26d9add3d72c46e1f6` |

Direct EntryPoint simulations, bypassing application preflight, rejected an arbitrary token transfer, a changed output recipient and an expired grant. Rejected operations did not consume the session nonce. The proof created one local ephemeral Kernel account and no public or protocol deployments.

External bundler compatibility is still unproven. Initial permission installation required roughly 2.7 million validation gas in the harness. The production session policy remains a fixed output-floor band: it does not guarantee that every smaller swap fits the same grant.

## Billing and funding boundaries

Provider-reported billing is recorded in native units with its separate USD equivalent. Unknown outcomes retain their reservation. Provider price filters are conservative controls, not a certification of hidden prompt-template token accounting.

The Galileo funding implementation checks the exact beneficiary, operating payer, chain, native currency, owner policy revision, expiry, lifetime deposit/gas cap, receipt identity and Router synchronization. It blocks a second deposit while an earlier credit is unresolved. Owner revocation remains possible when the provider is offline.

The production Router is chain 16661. Galileo funding uses chain 16602 and the official testnet Router. A production 0g-mode credit balance does not authorize a Galileo deposit. An inference-only key does not reveal a verified funding beneficiary. No management key was created and no public native compute-funding transfer was submitted; the later PaymentVault proof below writes only to an isolated fork.

PaymentVault uses `depositFor(address)` and `balanceOf(address)`. The distinct RouterPayment contract's `getUserBalance` getter must not be used against the vault. Sources: [0G deposits](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/account/deposits), [official PC application](https://pc.0g.ai/), and its public network/ABI configuration. Read-only Galileo RPC confirmed the vault has deployed code and accepts `balanceOf` calls.

## Native compute PaymentVault fork proof

`node --import tsx scripts/verify-compute-funding-fork.ts` passed against an isolated Galileo fork at block `64138857`, using the actual deployed PaymentVault and the existing funding builder, submitter, receipt reconciler and persistent policy ledger. The source chain was read-only; only localhost Anvil received writes. Fresh generated wallets and synthetic local native balance were used, with no real private key read, public transaction or contract deployment.

The verifier deposited 0.001 native 0G for the exact beneficiary. Actual local gas was 0.000064219000449533 0G, and the ledger settled 0.001064219000449533 once with no remaining reservation. The beneficiary's vault balance increased by exactly the deposit, an unrelated beneficiary stayed unchanged, and the owner wallet remained unfunded. The signed candidate hash was persisted before broadcast; SQLite was closed before settlement and reopened for real receipt recovery. The local-only hash was `0x76e710c73a9109439d03dd5c6f72ed036c36baba7f93542bd4eb7ca0fea3f069`.

The management-read input was an explicitly labelled local test fixture, not a real Router response or a mocked Router service. Real management authentication and worker synchronization were not proved. The resulting credit status remained `awaiting-router-sync`, and another deposit was refused while that status was unresolved. This establishes actual deployed-vault execution and durable payment recovery, not spendable Router credits, production funding or service revenue paying inference.

## Private inference boundary

Strict mode uses the official [0g-pc-e2ee verifier](https://github.com/0gfoundation/0g-pc-e2ee), inspected revision `c0e7d23f03adea19cbac36223bbeabe05cc8eaad`. The read-only verifier was built locally; it is not a runtime import from an ignored checkout.

Independent verification could establish hardware/certificate components but could not obtain the complete hash-matching raw app-compose identity. Public attestation requests returned HTTP 401, EOF/reset or HTTP 503. The published DockerCompose release is not interchangeable with the raw app-compose JSON whose hash is in the quote. Strict mode fails closed; no fabricated attestation or downgrade is used.

## Native storage expenses

The official Storage SDK version 1.2.13 transaction flow was inspected. Storage fees are transaction value, in addition to network gas. Backups now enforce separate owner-visible native caps, persist the signed candidate hash before broadcast and permit only one Flow submission. Receipt reconciliation binds network, sender, target, calldata hash, value and fee caps. Native expense records remain separate from the inference USD ledger.

Unknown uploads block duplicate paid backups. The owner can check the persisted receipt without re-uploading, re-signing or supplying transaction metadata. A confirmed payment does not prove file availability; finality and retrievability checks precede a successful backup status. Signing, cap, uncertainty and ledger edge cases use explicit fixtures. The successful funded round trip below uses the actual network.

## Earlier expanded live compute verification

`npm run verify:compute -- --allow-paid-inference --gateway-reported-private --extended`, against the local app, passed:

| Case | Real scoped tool | Router request IDs |
| --- | --- | --- |
| Save preference | remember_preference | `907d524e-ce62-46ec-8d6a-432843645dd3`, `3ee54342-b711-48ef-8262-f5c3b310ba67` |
| Recall preference | search_memory | `e457e9ea-3baa-491e-8bea-e784aeafc0ab`, `4eaf5e82-d6bc-413d-8917-61446a7aa0c0` |
| Real ETH market read | read_markets | `a659b2c9-5ab1-4ae9-9839-bd67cf88c66f`, `90f23769-ce0c-49b5-89d0-d530f972f88b` |
| Real candle RSI/SMA analysis | analyze_market | `be25e654-ca76-43f1-a554-c882d22daeb6`, `cf846d35-206a-46fb-8198-f68afa7edb0d` |
| Typed limit-order draft | propose_action | `12122dd7-bd6a-4bc8-a444-5ebb569b361b`, `90bcadc8-4aea-489d-aa4f-ebd028d8bf2d` |
| Typed price-alert draft | propose_automation | `76b1c70b-afe9-46ed-bc47-c74e1ae07560`, `ebd31295-2524-48b5-a689-1b4e206d03a5` |

All 12 calls in this earlier pass used gateway-reported sealed inference. Provider-reported total was 0.001472 USD equivalent, with zero outstanding reservation for that pass. Replaying the same request added no charge. Conflicting request reuse, credential-bearing input and exhausted allowance stopped without extra inference. Drafts did not submit an order or activate a job. Public API evidence contains only compact tool names, outcomes, timestamps and request IDs, not raw prompts/results or keys. These results do not supersede the later 502/unknown-billing recheck.

## Funded platform-paid storage proof

The user approved one round trip with maximum 0.013 testnet 0G, comprising gas up to 0.003 and storage value up to 0.01, bound to the payer and Flow below. Exactly one storage transaction was submitted. Source wallet credentials were copied only into ignored, owner-only local configuration, never prompts or Git.

- Network: Galileo 16602.
- Platform payer: `0x17A076d6cCaf37Bc9386EAB653A5EfAd8B07430C`.
- Flow: `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296`.
- [Confirmed public transaction](https://chainscan-galileo.0g.ai/tx/0xb8bef9e80581dd5f51781029b1235df55af1ab30bd7fe74336a983ed557b6992), block 64112417.
- Encrypted root: `0xccadc15c24bac5697de39cf1dac150fced8025fb6d8c4bcf04e873c87817783c`.
- Gas paid: 0.001259568002204244 testnet 0G.
- Storage fee: 0.000000061467289924 testnet 0G.
- Total: 0.001259629469494168 testnet 0G.

Upload finality and node availability were checked, followed by a proof-verified download and authenticated decryption. The database was closed and reopened before restoring the actual backup. A second, fresh Node process restored the same remote backup with both the operator signing credential and inference credential explicitly removed from its environment; no extra transaction was submitted. Read-only chain checks confirmed both the synthetic user's owner wallet and its agent operating wallet had exactly zero 0G. Only the platform payer spent native gas and storage value.

The operator path has a global payer nonce lock, per-backup ceilings and a shared UTC-day cap across all users. It rejects unresolved prior transactions and requests above operator limits. Additional public storage payments remain disabled in the ordinary local app after this one approved test; the verifier enabled storage only within its own process. Read-only quotes remain available with `npm run verify:storage`.

## Low-friction trading and sponsored gas

The existing Kernel account stack is retained. Both owner and agent paths require bounded sponsorship before signing and preserve the exact signed UserOperation payload at broadcast. The server-only paymaster proxy binds the authenticated owner, account derivation and factory, EntryPoint, control revision and exact reviewed calldata/value. Arbitrary account execution is not sponsored. Native-wrap permissions are explicit, capped and absent from old grants.

Gas accounting covers all five ERC-4337 v0.7 gas components. Per-operation, per-user/day, per-user operation-count and shared project/day ceilings use exact wei accounting. Returned approval fields are validated; provider errors do not disclose credentials. Estimation and final approval have separate provider-consumption flags. Unresolved issued approvals remain conservatively reserved across days, including the highest still-valid cost after a cheaper reissue. Trusted receipt reconciliation supports RPC hex values and SDK bigint values and is idempotent. Configuration does not imply funded provider approval.

Provider selection defaults to `ORCUS_GAS_SPONSOR_PROVIDER=operator`: a platform-wallet-funded EntryPoint deposit, a server-only gas-approval signer and a generic `BUNDLER_RPC_URL`. Kernel and user/agent keys do not change. ZeroDev hosted service is an explicitly selected secondary only. Browser sponsorship uses authenticated same-origin `orcus_sponsorUserOperation` without exposing provider credentials or falling back to another payer. Public paymaster deployment, EntryPoint ETH deposit/stake and canonical bundler admission remain unperformed external steps; the separate operator fork proof uses an ephemeral local deployment only.

The [current ZeroDev pricing page](https://www.zerodev.app/pricing), checked November 6, 2026, lists a $0 testnet-only Sandbox, 10,000 monthly credits and 20 credits per bundled operation. It also lists an 8% sponsorship premium, but does not clarify its treatment for testnet funds. Launch is $69/month. This is a bounded optional hosted service, not a promise of unlimited free testnet gas; ordinary users never need to create its account.

An external-wallet deposit still requires owner-paid Sepolia gas. Token deposits now check that balance before signing, rather than discovering the missing gas inside the wallet. Funding intent is saved before the wallet flow starts; refreshes preserve uncertainty instead of inviting an identical retry. Cancellation, rejection, pending receipts and uncertain submission have separate safe messages. No owner private key is requested, and no automatic paid-gas fallback was introduced.

Native ETH input is an exact WETH deposit plus protected swap in one smart-account operation. Native ETH output is not implemented or labelled as available. The real Kernel fork proof was repeated successfully at Sepolia block `12075053`, with six successful local UserOperations and no public writes or protocol deployments. Representative local-only receipts:

- Owner native-input swap: `0xea3b480252e24df80860c7198f7c8cd3058cae05ac0f98254231b0251e43a288`.
- Agent native-input swap on the same account: `0xa32e8631d171bbf01ee95bc0a0dbfe793b13275397ce6e8dbf711271b8877a9a`.

The fork rejects token/native transfers outside the grant, wrapping above the cap, a changed swap recipient and expired authority. Repeated permitted wrapping keeps WETH in the same user account. Earlier pinned-block proofs also passed, but later replay encountered unavailable historical state from the public RPC. Selecting a retained block restored the proof; an archival provider is needed for reliable replay of the older pinned fixture.

The earlier native-input pass added actual CRE `balanceAt` capability reads at the observed block. WETH/USDC retain ERC20 balance reads. Proposal comparison binds native-input choice, and missing/insufficient native evidence rejects. That pass had three capability fixtures and a typecheck/WASM build, not an authenticated simulation. The later actual CLI proof below supersedes that authentication limitation.

That earlier 404-application-test snapshot and three workflow fixtures were historical build checks, not current suite totals. Its read-only diagnostics returned one Uniswap market and 159 Hyperliquid markets. No additional paid inference, public storage payment, public trade or deployment occurred during that pass.

The earlier root audit reported 11 upstream findings, including storage-SDK Axios and ethers WebSocket dependencies. Those findings were subsequently addressed with compatible dependency overrides and regression/fork checks; they are not current unresolved root findings. The separate CRE workflow audit remains independently tracked in the automated-verification summary.

The implementation follows the existing SDKs and primary references: [ZeroDev sponsorship](https://docs.zerodev.app/smart-accounts/sponsor-gas/evm), [provider gas policies](https://docs.zerodev.app/api-and-toolings/infrastructure/gas-policies), and [Uniswap Sepolia deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments).

## Independent operator-paymaster fork acceptance

`npm run verify:operator-paymaster-fork` passed independently against actual Sepolia protocol state on isolated Anvil. Only the ephemeral local paymaster and Kernel account were deployed. Six successful local UserOperations exercised owner wrapping/swaps, native input, scoped agent execution and owner management of agent-acquired holdings. EntryPoint events reported successful execution with the operator paymaster; its deposit paid the exact gas costs while both owner and agent signer ETH balances remained zero. Trading capital remained in the user's Kernel account, separate from sponsor funds.

Nine negative sponsorship cases rejected expired/future authorization, wrong chain/EntryPoint, invalid signature or estimation stub, tampered gas/calldata and excessive authorized cost. Solidity and TypeScript EIP-712 hashes matched. Administrative non-owner calls and native session-policy violations were also rejected. The verifier binds the exact operation envelope, reconciles deposit debits and leaves unknown outcomes reserved rather than retrying.

This is real local EntryPoint/paymaster execution, not merely mocked sponsorship. It does not exercise a canonical public bundler's admission rules, a publicly deployed/funded/staked paymaster or a live browser-extension sponsored trade. No public network write occurred.

An independent root rerun on November 6 used `ORCUS_FORK_BLOCK=12075622 npm run verify:operator-paymaster-fork` after the normalized close-cap and quote-validation fixes. All six operations and nine sponsorship denials passed again, with zero ETH in owner/session signers and zero public writes. The exact operator deposit debit was `5190838062413` wei. Local-only owner-native-input receipt: `0x61593ff7a4e6911b56a66a767afa58a0244660f2a12a337b96660a4a0f8685f7`; agent-native-input receipt: `0x0485e5466c2be602572af26c472f8a3e0b7462839ccc5c150162f029db911254`. These are not public explorer receipts or proof of canonical bundler admission.

## Authenticated CRE CLI and actual worker consumption

`npm run verify:cre -- --account-address=<read-only observation address>` passed five actual simulations through the official authenticated CLI, SDK and configured Sepolia/external HTTP capabilities. An independent root rerun observed Sepolia blocks `12075622`-`12075624`. The verifier uses no signing key and makes zero billable inference calls or public network writes.

| Case | Actual result |
| --- | --- |
| Native ETH input with sufficient observed balance | Allow, with native balance, block and market-source evidence |
| ERC20 input without sufficient observed balance | Reject |
| Unsatisfied market condition | No action |
| Candidate altered from the approved request | Reject |
| Real worker read-only price alert | Allow consumed into one persisted notification, zero trading actions |

The alert passed through `Platform.tick()` and the real local runner rather than directly inserting a final result. Repeating the tick produced no second notification or action. Closing/reopening SQLite retained the notification. Namespaced evaluation-run/proposal/progress records prevent global-ID collisions from silently dropping final results; fixture tests separately cover duplicate request recovery without extra inference charges.

The workflow connects real onchain observations and external data to a user-visible automation feature. Local simulation is not hosted DON consensus. This read-only proof does not establish a fresh real 0G proposal -> CRE allow -> permissioned venue settlement chain; that combined trading acceptance remains open. Hosted deployment approval, report verification and commercial access remain separate future gates, not prerequisites for the demonstrated CLI simulation.

## Actual Hyperliquid testnet owner/agent handoff

The approved capped verifier passed against the real Hyperliquid testnet API using owner `0x17A076d6cCaf37Bc9386EAB653A5EfAd8B07430C`. It allowed one opening request, at most 20 mock USDC notional and at most 1 mock USDC total fees. Existing positions/orders would have stopped the test before any mutation. No deposit, withdrawal, transfer, mainnet operation or second opening was authorized or submitted.

| Step | Venue evidence |
| --- | --- |
| Fresh native agent approved | `orcus-d800cf8c3a`, address `0x99230A05D10cCE88E805c0eEd89c47e8467BbaA0`, with a short expiry |
| Owner opened one ETH long | Order `64660909972`, size `0.0089`, price `2229.8`, opening notional `19.84522` mock USDC |
| Agent created a reduce-only stop; owner cancelled it | Order `64660915131`, observed open then cancelled |
| Agent created a reduce-only take-profit; agent cancelled it | Order `64660921462`, observed open then cancelled |
| Agent closed the owner's same-account position | Order `64660932664`, size `0.0089`, price `2231.1`, observed fully filled |
| Cleanup and revocation | Zero positions/orders, fresh agent revoked, pre-existing `naryx-testnet` agent retained unchanged |

Actual opening fill hash: `0x45315fb884ec601346ab042d83dd44010200779e1fef7ee5e8fa0b0b43e039fd`. Closing fill hash: `0x5d8f7665fda55d115f09042d83de990105008e4b98a87be3015821b8bca936fc`. Opening/closing fees were `0.00893` and `0.008935` mock USDC, totaling `0.017865`. Balance changed from `185.426761` to `185.420466` mock USDC after realized P&L and fees. These are mock testnet assets, not dollar-valued production results or a profitability claim.

The verifier reused the real preparation, agent submission and reconciliation adapters, and the supported SDK for owner signing. It persisted public action IDs and pending intent before sends, reconciled actual fills and did not retry opening requests. Public-only evidence remains outside Git in the runtime verification directory. A first, zero-write attempt exposed a real compatibility issue: viem's strict EIP-712 struct validation rejects Hyperliquid's colon-containing approval type. Supported ethers signing now handles owner approval/orders without modifying the native schema; wallet/network checks still run around browser signatures. The initial failed journal was preserved separately after verifying no approval or order had been broadcast.

Wallet tests now include actual SDK approval and order signing against an injected browser provider, owner-change rejection before broadcast, plus the verifier's boundary tests. This does not certify a real browser-extension session, an autonomous 0G conversation causing a live trade, native enforcement of application-defined notional limits or mainnet safety. No additional public writes are required to repeat the read-only inspection.

Primary references: [Hyperliquid exchange API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint) and [native API wallets and nonces](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets).

## Testnet service payment expiry and recovery

The testnet checkout has fixed pricing: one Sepolia test USDC grants one USD-equivalent test credit. Quote expiry blocks starting a new wallet flow. It does not reject an exact successful transfer merely because the wallet was approved late, the transaction mined after expiry, or the unpaid intent was dismissed. ERC20 transfers have no onchain deadline, so a receipt upper-time cutoff could otherwise take the transfer without granting its credits.

Recovery still verifies the exact owner, token, treasury, amount, zero native value, post-creation block and canonical confirmed Transfer event. Global transaction/log uniqueness prevents double credit. A pre-intent transaction cannot qualify. This is test-token accounting, not live revenue or a token refund.

`scripts/verify-service-payment-fork.ts` passed with an actual transfer on the existing [Circle Sepolia USDC contract](https://developers.circle.com/stablecoins/usdc-contract-addresses). It minted local test balances using fork-only impersonation, transferred one test USDC to an ephemeral treasury, required two confirmations and credited once. The proof refused unpaid inference, retained an unknown compute reservation, reopened SQLite, settled an explicit provider-billing fixture and rejected transfer-event replay. Final test-credit accounting: paid 1.000000, spent 0.020000, reserved 0, released 0.080000 and remaining 0.980000 USD equivalent. Public writes and protocol deployments were both zero. The expense fixture does not prove a paid external inference or real revenue.

The owner wallet helper checks its token balance, simulates the transfer, verifies a 20%-buffered EIP-1559 fee envelope and available Sepolia ETH before the wallet popup; checkout caps that envelope at 0.003 ETH. Tests cover exact fee fields, missing gas/tokens, rejection, known-hash recovery and uncertain submission. Owner-scoped UI request generations reject late responses after a switch or unmount, and the checkout remounts by normalized owner address.

Operator gas authorization additionally checks the actual EntryPoint deposit and locked-stake policy before signing. [ERC-7562](https://eips.ethereum.org/EIPS/eip-7562) separates these balances and leaves the minimum stake amount adjustable per chain. The configured operator stake amount is not guessed; external provider admission remains unproven until its own acceptance succeeds.

## Functional browser and durable-result acceptance

`npm run verify:browser -- http://localhost:3124` passed against an isolated actual Next.js application, real HTTP routes and a real SQLite database. Chromium used fresh disposable owners through an injected EIP-1193 provider; signing keys stayed in the verifier process. The app had no inference credentials, no worker performing paid evaluations and no funded trading permissions. This is not a real browser extension or a public trading demonstration.

An independent November 6 root rerun also passed all seven cases against the actual production build on loopback port 3125. This strengthens the production-build interface proof without changing the injected-wallet, no-public-write or no-paid-inference boundaries. The read-only CRE rerun at blocks `12075622`-`12075624` and operator-paymaster fork above were separate acceptance runs, not one combined inference-to-trade demonstration.

The browser proof verified rejected login produces no session; signed login and owned venue-account registration; distinct owner, trading and operating wallet roles; rapid double pause producing exactly one HTTP mutation; resume; expired automation disabled in the interface and rejected by the actual API; owner change clearing private drafts, session and accounts; and a deliberately delayed old-owner wallet check completing after owner B logged in without clearing or logging out B. It submitted zero trade signatures, public venue writes or inference calls. Temporary browser profiles were removed after the run; the isolated synthetic application data remained outside the repository.

Functional changes also retain previous disabled/rotated signer addresses and explicitly warn that application disablement does not prove native revocation. Supported smart-account recovery still requires an owner-reviewed native operation; missing gas sponsorship does not fabricate a successful revoke. Failed/budget-paused/expired automation states explain the next action, and expired schedules no longer offer a misleading Resume action.

A persistence regression exposed globally unique `records.id` values reused by run progress and completed proposals. Physical IDs are now namespaced per kind/user, while logical run/evaluation and expense references remain unchanged. Namespaced reads prefer new records and retain legacy cache/progress compatibility. Regression tests use real signed HTTP boundary requests and SQLite reopen with an explicitly mocked, non-paid inference result: the typed proposal survives separately from progress, repeating the request performs no second inference or expense, and strategy run/cache/final evaluation rows coexist. These tests do not claim a new paid 0G run.

The position-selection guard now matches explicit instrument tokens rather than substrings and requires exactly one matching open position when several exist. Regression fixtures reject ambiguous "close it", incidental "whether"/ETH text, conflicting instrument mentions and a proposal targeting a different named position. Existing same-account native venue evidence remains recorded in the preceding section.

## Remaining external acceptance

The shared inference account is protected by exact operator-controlled USD-equivalent ceilings in the existing atomic compute reservation path. Defaults are 1 per user per UTC day and 10 across the project. Focused tests cover the exact micro-dollar boundary, simultaneous tenants, owner cap edits, duplicate requests, held unknown costs across midnight, actual settlement-day accounting, rejected-call release, invalid configuration and refusal before agent/provider work begins. These are spending controls, not customer payment evidence or a guarantee about unreported provider billing.

- Actual authenticated CRE CLI simulation and durable alert consumption now pass. The combined real 0G planning/CRE/trade-settlement demonstration and hosted DON execution remain unproved, for different reasons.
- The capped native Hyperliquid owner/agent handoff is live testnet-verified. Complete browser-extension acceptance, additional account modes and external Sepolia bundler execution remain separate.
- Encrypted storage upload/download/restore is live-verified with a funded platform payer. The deployed compute PaymentVault and receipt recovery pass on fork, but actual matching Router management access and post-deposit credit synchronization remain unproved. Compute credits and native storage funds are separate.
- Testnet-only service checkout and receipt-backed credit accounting are implemented and fork-verified; real-money collection remains disabled. Capped Uniswap sponsorship uses the platform's operator path by default, but its paymaster deployment, EntryPoint ETH deposit and stake, generic bundler configuration and live external acceptance are not configured or proven. ZeroDev remains an explicit secondary, not an automatic fallback.
- Root full/production dependency audits report zero known findings after compatibility fixes. The separate workflow dependency graph retains two upstream high findings because an attempted incompatible override broke actual SDK/WASM execution. Neither graph nor these functional checks certify production safety.
- Optional earned funding remains off. Sponsor credits, owner deposits and theoretical trading profit are not proof of service revenue funding inference.
- Public repository publication, feedback-form submission, hosted deployment and demo recording were not performed.

## Latest isolated compute recheck

A final HTTP application recheck started from unified source revision `5a86030`, using a fresh external runtime directory and a generated, unfunded owner. The app listened only on loopback. Storage, CRE and service-payment collection were disabled for this proof. The synthetic owner expense cap and both operator compute ceilings were restricted to 0.05 USD equivalent. Credentials were loaded opaquely and never printed or committed.

Wallet authentication and budget/private-mode setup succeeded. The first model call returned an upstream 0G HTTP 502, exposed as the sanitized `INFERENCE_REJECTED` application error. The verifier stopped immediately and logged out; no retry, second synthetic user or extra provider request was initiated. The failed request had error identity `cfcaa15dc039bae7`. Its billing was unverified: local settled spend was 0.000000 USD equivalent and an unknown reservation of 0.010000 remained held. This is not evidence of a zero provider charge or a successful inference.

The namespaced failed agent-run record was persisted with one model call and zero tool calls. No trade, approval, onchain payment, storage write or deployment occurred. The extended tools, memory, typed draft and cold-restart replay cases were not reached and are not claimed as newly verified. The isolated runtime was initially retained for billing reconciliation; its subsequent loss after the laptop reboot is recorded below. Existing user runtime data was not touched.

The verifier now supports an optional `--restart-replay` gate after all extended checks and the budget-stop case succeed. It pauses for restarting the same app against the same database, then replays only the original request and checks unchanged provider IDs, spend, reservations and persisted memory. Four unit tests and strict script typechecking passed for this guard. That unit coverage is not a successful live restart proof; the current upstream 502 prevented reaching the gate.

## Billing recovery and resource-safe verification

The owner can now use Check provider billing for an unknown expense. The authenticated endpoint accepts only its expense ID and reads the official Router management history. Settlement requires the original request, public API-key ID, model, time window and official network origin, complete bounded pagination and an exact USD micro-cost within the original reservation. Global proof uniqueness and an atomic update prevent duplicate settlement across expenses or users. Missing records, missing original identity, native 0G costs without verified USD evidence, provider failures and conflicting history leave the reservation held. No inference, payment or top-up is retried. The UI rejects stale owner responses and overlapping clicks. HTTP error responses with verified booked charges no longer release their reservation as if they were free.

The laptop rebooted during overlapping verification commands. The prior boot's kernel journal was unavailable, so an individual OOM culprit was not established. Interrupted command completions are not counted as passes. Further checks run serially in user systemd scopes with MemoryMax=4G, MemorySwapMax=512M and CPUQuota=200%. Vitest defaults to two workers and serial files, including ad-hoc root calls; Next static-build workers are limited to two. Native build threads still require the aggregate cgroup limit.

After the reboot, the isolated paid-check directory `/tmp/orcus-final-compute-uqUzNx` was absent. Its temporary database is no longer available; the recorded request identity and unknown 0.010000 USD-equivalent reservation remain historical evidence, not proof of zero provider charges. No paid attempt was repeated. Normal application data lives on persistent local disk outside the checkout. Future billable verification must use a persistent verification directory until billing is resolved.

## Native Ostium CRE integration and read-only acceptance

Source reviewed through `c21352b`: shared verified deployment constants (`6bdfeb9`), native workflow/managed runner integration (`dfb6290`), live SDK-canonical symbol aliases (`39b1903`) and zero-size native cancellation validation (`c21352b`). Native observations resolve the current testnet pair/feed, use exact E18 quote-currency prices and read actual six-decimal USDC at the observed Arbitrum Sepolia block. Global instruments are not mapped to guessed Coinbase tickers. A CRE allow remains separate from fresh wallet authority and execution policy checks.

The actual receiver-free CLI simulation produced:

```text
ORCUS_CRE_LOCAL_RESULT={"mode":"local-simulation","currentPrice":"2240.66","previousPrice":"1","changed":true,"wouldWrite":false}
```

The [native read-only verifier](../../scripts/verify-ostium-cre.ts), using the actual [managed CLI adapter](../../agent/src/automation/cre.ts) and [native observation capability](../../workflows/cre/strategy/ostium.ts), then passed an above-`1` XAU/USD alert. It observed pair `5`, price `4069.64875` USD, Arbitrum Sepolia block `326623115`, actual testnet-USDC balance `0` and oracle fee `0.5` USDC. Complete feed/evaluation identity passed the managed parser and binding checks. The result was `allow` for notification only. These are dated observations, not runtime defaults.

The initial native attempt was correctly rejected because the CLI truncated a single result log at approximately 1,024 characters. The workflow now emits ordered base64 frames of at most 512 decoded bytes. The parser requires matching counts/order, rejects duplicate/missing/mixed-format or invalid UTF-8 data, caps the reconstructed result at 32 KiB, then validates schema and account/policy/evaluation/expiry bindings. The corrected actual managed CLI run passed; truncation was not treated as success.

Ten changed native workflow/runner/server fixtures and four relevant typechecks passed serially. Two additional framing fixtures and final engine typecheck passed after the framing fix. One targeted core boundary fixture passed for amount `0` only on Ostium cancellation with an exact nonempty order ID and explicit base units; all other action amounts remain positive. Counts describe focused checks, not a repeated full-suite total. At this slice, native interface components had 29 passing tests; their subsequent integrated acceptance is recorded below.

Public-network writes, paid inference, grants, payments, deployments and broadcasts were zero in these CRE runs. This does not prove hosted DON consensus, a fresh 0G proposal or native authorized trade settlement. The [workflow README](../../workflows/cre/README.md) retains reproduction instructions and the local-runner trust boundary. Original optional earned-funding, combined 0G/CRE/trade and publication gates remain unchanged.

## Integrated workspace and native interface acceptance

The merged source through `1d4e0a8` provides real Overview, Trade, Agent, Automations, Activity and Settings routes, with the separate `/landing` preview. The production webpack build, TypeScript check and static generation passed. The active loopback preview runs from main, preserving its persistent runtime data; this is not a public deployment. UI verification passed 118 focused cases in eight files. The 29 native component cases overlap that scope and are not added again; no new full-workspace-suite total is claimed.

The [actual browser verifier](../../scripts/verify-browser.ts) passed ten local checks against the real HTTP/SQLite application with disposable injected wallet identities, not an installed extension. Coverage includes signed/rejected login, shared-document route/back navigation, exactly one pause mutation, durable queued work without an automatic repost, all six mobile pages, expired-automation denial, clearing private state on wallet switch and rejecting a delayed prior-owner response. The final rebuilt verifier also passed the updated notice-clearing assertion. Browser reposts, trade signatures, public venue writes and paid inference calls were zero.

Desktop/mobile review covered every page, Costs/Agent/Services settings sections and the read-only native account/terminal screens. Overview uses the landing's crafted card hierarchy; Activity groups technical evidence below the useful result. All 48 inspected depth numeric cells were unclipped. The empty mobile Agent has an 18 px suggestion/composer gap without an inner empty-state scrollbar; the mobile Settings section selector and back navigation work. After the final patch, noncritical notices clear on navigation or after five seconds while errors and durable pending records remain. Final Agent/mobile Agent/budget captures confirm normal prose typography instead of monospace body text.

The live native catalog changed during development: a final BTC/USD observation was tradable with leverage limits `1`-`50`, unlike its earlier disabled snapshot. The application discovers current market state; neither observation becomes a permanent configuration or a guarantee of future availability. Native order entry, position/order/history controls, authority disclosure and exact allowance/recovery interfaces are integrated through the [shared workspace](../../web/src/components/workspace/workspace-shell.tsx), [native ticket](../../web/src/components/trading/ostium-order-ticket.tsx) and [owner account controls](../../web/src/components/agent/ostium-account-card.tsx).

Checklist status is 71/75 locally/evidence-qualified, not production certification. Public native funding/delegation/trades, installed-wallet acceptance, public paymaster/bundler readiness, strict independent TEE verification and matching Router-credit synchronization retain their existing gates. Optional earned funding (`C8.5`), combined actual 0G/CRE/venue settlement (`C9.6`), and sponsor public demo/publication requirements (`C10.1`, `C10.2`) remain unchecked. No new execution was performed for this documentation closeout.

## Single-EC2 hackathon code closeout

The hosting scope is one ordinary AWS EC2 testnet demo with web and worker services, not a production backup, replication, managed-database or KMS project. Basic local state and the original encryption key are retained through ordinary app restarts. The [AWS runbook](../../deploy/aws/README.md) prepares hosting only; the user will provide instance and domain details later.

At source `9e1490c`, the merged first-run setup, private worker destination, stricter configuration doctor, AWS units/installer and credential-safe CRE check passed final validation from an unserved worktree:

- Nine focused files passed 127 tests, including all four final joined planning/CRE/execution-boundary fixtures, synthetic setup/key-preservation cases, doctor no-network checks, worker configuration and AWS installer/CLI-wrapper checks. This is not an additive count on top of the earlier overlapping baselines.
- All five workspace typechecks passed.
- `npm run build -- --webpack` passed. Only the existing dynamic-expression import warnings from the agent and ox/viem paths remained.
- The actual worker entrypoint started with a pristine synthetic environment, a public HTTPS origin deliberately different from its loopback destination, and a randomly generated test token. It sent one correctly authenticated `POST /api/internal/tick` to a disposable local HTTP stub, then exited successfully on SIGTERM. This did not run a worker against the app's real database or call an external provider.

An earlier isolated closeout run also passed the official CRE WASM compiler and one authenticated, receiver-free command: `cre workflow simulate strategy --target local-simulation --non-interactive --trigger-index 0`. Its actual HTTP result included `mode: local-simulation`, `changed: true` and `wouldWrite: false`. The new four-case joined regression uses explicitly labelled provider/capability/venue fixtures; it does not turn that native read-only simulation into a paid-inference or public-trade proof.

The compatible official SDK remains unchanged. The separate workflow audit still reports two high entries, Zod 3.25.76 and its dependent CRE SDK, from the single [GHSA-mrhx-c7xc-m3w5 advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). No compatible patched Zod 3 or SDK update was available in the checked package metadata. A bounded three-element mechanism check showed that v3 visits array elements before rejecting an exceeded upper bound, unlike the patched v4 path; this is not a demonstrated reachable application OOM. No incompatible override, hidden audit result or production-security certification is claimed.

This pass made no AWS calls, resource creations, service installations, public wallet actions, paid inference calls or storage uploads. No real `.env`, signing credential or runtime key was copied or printed. Actual AWS hosting, private provider configuration, public funded sponsorship and the combined live demonstration remain separate operator/acceptance steps. Optional strict TEE, earned funding and automatic compute replenishment do not block preparing the standard testnet demo, but remain unverified and must not be advertised as complete.
