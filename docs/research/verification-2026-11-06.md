# Local verification, 2026-11-06

This is execution evidence, not deployment configuration. Initial trading verification used local forks only. A later, separately authorized Galileo storage test submitted the single public transaction recorded below. No token launch, funded public trade or public contract deployment was performed. Local Uniswap fork hashes are not public explorer receipts.

## Automated verification

The latest suite passed 340 tests: 26 frontend, 160 engine, 9 core, 114 server and 31 wallet tests. All application workspaces typechecked. The Next.js production build and official CRE WASM build passed. Verification scripts also passed a standalone strict TypeScript check. Earlier output-trace checks included no inspiration checkout, environment file or Git metadata; the configured credentials remain excluded from Git.

These results do not imply live CRE authentication, public execution or production-security certification.

## Real 0G application flow

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

The production Router is chain 16661. Galileo funding uses chain 16602 and the official testnet Router. A production 0g-mode credit balance does not authorize a Galileo deposit. An inference-only key does not reveal a verified funding beneficiary. No management key was created and no native funding transfer was submitted.

PaymentVault uses `depositFor(address)` and `balanceOf(address)`. The distinct RouterPayment contract's `getUserBalance` getter must not be used against the vault. Sources: [0G deposits](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/account/deposits), [official PC application](https://pc.0g.ai/), and its public network/ABI configuration. Read-only Galileo RPC confirmed the vault has deployed code and accepts `balanceOf` calls.

## Private inference boundary

Strict mode uses the official [0g-pc-e2ee verifier](https://github.com/0gfoundation/0g-pc-e2ee), inspected revision `c0e7d23f03adea19cbac36223bbeabe05cc8eaad`. The read-only verifier was built locally; it is not a runtime import from an ignored checkout.

Independent verification could establish hardware/certificate components but could not obtain the complete hash-matching raw app-compose identity. Public attestation requests returned HTTP 401, EOF/reset or HTTP 503. The published DockerCompose release is not interchangeable with the raw app-compose JSON whose hash is in the quote. Strict mode fails closed; no fabricated attestation or downgrade is used.

## Native storage expenses

The official Storage SDK version 1.2.13 transaction flow was inspected. Storage fees are transaction value, in addition to network gas. Backups now enforce separate owner-visible native caps, persist the signed candidate hash before broadcast and permit only one Flow submission. Receipt reconciliation binds network, sender, target, calldata hash, value and fee caps. Native expense records remain separate from the inference USD ledger.

Unknown uploads block duplicate paid backups. The owner can check the persisted receipt without re-uploading, re-signing or supplying transaction metadata. A confirmed payment does not prove file availability; finality and retrievability checks precede a successful backup status. Signing, cap, uncertainty and ledger edge cases use explicit fixtures. The successful funded round trip below uses the actual network.

## Expanded live compute verification

`npm run verify:compute -- --allow-paid-inference --gateway-reported-private --extended`, against the local app, passed:

| Case | Real scoped tool | Router request IDs |
| --- | --- | --- |
| Save preference | remember_preference | `907d524e-ce62-46ec-8d6a-432843645dd3`, `3ee54342-b711-48ef-8262-f5c3b310ba67` |
| Recall preference | search_memory | `e457e9ea-3baa-491e-8bea-e784aeafc0ab`, `4eaf5e82-d6bc-413d-8917-61446a7aa0c0` |
| Real ETH market read | read_markets | `a659b2c9-5ab1-4ae9-9839-bd67cf88c66f`, `90f23769-ce0c-49b5-89d0-d530f972f88b` |
| Real candle RSI/SMA analysis | analyze_market | `be25e654-ca76-43f1-a554-c882d22daeb6`, `cf846d35-206a-46fb-8198-f68afa7edb0d` |
| Typed limit-order draft | propose_action | `12122dd7-bd6a-4bc8-a444-5ebb569b361b`, `90bcadc8-4aea-489d-aa4f-ebd028d8bf2d` |
| Typed price-alert draft | propose_automation | `76b1c70b-afe9-46ed-bc47-c74e1ae07560`, `ebd31295-2524-48b5-a689-1b4e206d03a5` |

All 12 calls used gateway-reported sealed inference. Provider-reported total was 0.001472 USD equivalent, with zero outstanding reservation. Replaying the same request added no charge. Conflicting request reuse, credential-bearing input and exhausted allowance stopped without extra inference. Drafts did not submit an order or activate a job. Public API evidence contains only compact tool names, outcomes, timestamps and request IDs, not raw prompts/results or keys.

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

Provider selection now defaults to `ORCUS_GAS_SPONSOR_PROVIDER=operator`: a platform-wallet-funded EntryPoint deposit, a server-only gas-approval signer and a generic `BUNDLER_RPC_URL`. The Kernel account implementation and user/agent keys do not change. ZeroDev's hosted service is used only when explicitly selected as the secondary. Browser sponsorship uses the authenticated same-origin `orcus_sponsorUserOperation` method and never sends provider credentials or automatically falls back to another payer. Operator paymaster deployment, ETH deposit and public bundler acceptance remain unperformed external steps.

The [current ZeroDev pricing page](https://www.zerodev.app/pricing), checked November 6, 2026, lists a $0 testnet-only Sandbox, 10,000 monthly credits and 20 credits per bundled operation. It also lists an 8% sponsorship premium, but does not clarify its treatment for testnet funds. Launch is $69/month. This is a bounded optional hosted service, not a promise of unlimited free testnet gas; ordinary users never need to create its account.

An external-wallet deposit still requires owner-paid Sepolia gas. Token deposits now check that balance before signing, rather than discovering the missing gas inside the wallet. Funding intent is saved before the wallet flow starts; refreshes preserve uncertainty instead of inviting an identical retry. Cancellation, rejection, pending receipts and uncertain submission have separate safe messages. No owner private key is requested, and no automatic paid-gas fallback was introduced.

Native ETH input is an exact WETH deposit plus protected swap in one smart-account operation. Native ETH output is not implemented or labelled as available. The real Kernel fork proof was repeated successfully at Sepolia block `12075053`, with six successful local UserOperations and no public writes or protocol deployments. Representative local-only receipts:

- Owner native-input swap: `0xea3b480252e24df80860c7198f7c8cd3058cae05ac0f98254231b0251e43a288`.
- Agent native-input swap on the same account: `0xa32e8631d171bbf01ee95bc0a0dbfe793b13275397ce6e8dbf711271b8877a9a`.

The fork rejects token/native transfers outside the grant, wrapping above the cap, a changed swap recipient and expired authority. Repeated permitted wrapping keeps WETH in the same user account. Earlier pinned-block proofs also passed, but later replay encountered unavailable historical state from the public RPC. Selecting a retained block restored the proof; an archival provider is needed for reliable replay of the older pinned fixture.

CRE now reads native ETH through its actual `balanceAt` capability at the observed block for native-input strategies. WETH/USDC inputs retain ERC20 balance reads. Proposal comparison binds the native-input choice, and missing or insufficient native evidence rejects the evaluation. Three explicit capability-fixture tests and the official typecheck/WASM compiler pass. This is not a successful authenticated CLI simulation.

Verification totals: 404 application tests and three workflow capability-fixture tests; application, script and workflow typechecks; Next production build; CRE WASM build. Real read-only diagnostics returned one Uniswap market and 159 Hyperliquid markets. No additional paid inference, public storage payment, public trade or deployment was performed during this pass.

`npm audit --omit=dev` reports 11 existing upstream dependency findings: four high and seven moderate. They include Axios through the storage SDK and WebSocket dependencies through ethers. No blind major-version override was applied. Compatibility and actual exposure require triage before production or real-fund use. Relevant upstream advisories: [Axios absolute-URL handling](https://github.com/advisories/GHSA-jr5f-v2jv-69x6) and [WebSocket memory exhaustion](https://github.com/advisories/GHSA-96hv-2xvq-fx4p).

The implementation follows the existing SDKs and primary references: [ZeroDev sponsorship](https://docs.zerodev.app/smart-accounts/sponsor-gas/evm), [provider gas policies](https://docs.zerodev.app/api-and-toolings/infrastructure/gas-policies), and [Uniswap Sepolia deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments).

## Remaining external acceptance

- CRE CLI authentication will be supplied later. Workflow compilation is not a successful CLI simulation, and no hosted DON execution is claimed.
- Funded Hyperliquid authorization/trading and external Sepolia bundler execution require owner actions and accounts.
- Encrypted storage upload/download/restore is now live-verified with a funded platform payer. Actual compute replenishment still needs a matching verified Router account and management-read access. Compute credits and native storage funds are separate.
- User-facing payment collection remains unimplemented; an allowance is not paid service credit. Capped Uniswap sponsorship uses the platform's operator path by default, but its paymaster deployment, EntryPoint ETH deposit, generic bundler configuration and live external acceptance are not configured or proven. ZeroDev remains an explicit secondary, not an automatic fallback.
- Dependency-audit findings remain unresolved. The hackathon implementation is not certified production-safe by these functional checks.
- Optional earned funding remains off. Sponsor credits, owner deposits and theoretical trading profit are not proof of service revenue funding inference.
- Public repository publication, feedback-form submission, hosted deployment and demo recording were not performed.
