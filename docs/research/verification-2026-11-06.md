# Local verification, 2026-11-06

This is execution evidence, not deployment configuration. No public-chain writes, token launches, funded public trades or protocol deployments were performed. Local fork hashes are not public explorer receipts.

## Automated verification

All 273 tests passed: 26 frontend, 156 engine, 9 core, 51 server and 31 wallet tests. All application workspaces typechecked. The Next.js production build and official CRE WASM build passed. Verification scripts also passed a standalone strict TypeScript check. Output tracing included no inspiration checkout, environment file or Git metadata; the configured API key was absent from tracked files and compiled server bundles.

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

Unknown uploads block duplicate paid backups. The owner can check the persisted receipt without re-uploading, re-signing or supplying transaction metadata. A confirmed payment does not prove file availability; finality and retrievability checks precede a successful backup status. Storage signing, cap, uncertainty and ledger tests use explicit fixtures; no funded storage round trip is claimed.

## Remaining external acceptance

- CRE CLI authentication will be supplied later. Workflow compilation is not a successful CLI simulation, and no hosted DON execution is claimed.
- Funded Hyperliquid authorization/trading and external Sepolia bundler execution require owner actions and accounts.
- Actual0G Storage upload/download and native replenishment require funded operating wallets and a matching verified provider account. Compute inference credits do not pay Galileo storage gas.
- Optional earned funding remains off. Sponsor credits, owner deposits and theoretical trading profit are not proof of service revenue funding inference.
- Public repository publication, feedback-form submission, hosted deployment and demo recording were not performed.
