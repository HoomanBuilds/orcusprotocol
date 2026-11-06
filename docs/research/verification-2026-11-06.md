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

## Remaining external acceptance

- CRE CLI authentication will be supplied later. Workflow compilation is not a successful CLI simulation, and no hosted DON execution is claimed.
- Funded Hyperliquid authorization/trading and external Sepolia bundler execution require owner actions and accounts.
- Encrypted storage upload/download/restore is now live-verified with a funded platform payer. Actual compute replenishment still needs a matching verified Router account and management-read access. Compute credits and native storage funds are separate.
- User-facing payment collection and Uniswap paymaster sponsorship remain unimplemented; an allowance is not paid service credit and backend sponsorship does not make all trades gasless.
- Optional earned funding remains off. Sponsor credits, owner deposits and theoretical trading profit are not proof of service revenue funding inference.
- Public repository publication, feedback-form submission, hosted deployment and demo recording were not performed.
