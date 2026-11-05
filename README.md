# Orcus ETHGlobal

A personal-agent trading platform where users and authorized agents manage the same supported trading accounts. Manual controls and agent capabilities share execution, permissions and position state. Users never share their wallet private keys.

Sponsor targets: 0G inference and encrypted memory, Uniswap spot execution, and Chainlink CRE for conditional strategy orchestration. Hyperliquid supplies an additional trading venue. CRE starts in local simulation with real testnet/API calls and a managed runner; this is not hosted DON execution.

## Project documentation

- [Implementation plan](docs/plans/implementation-plan.md): architecture, reuse decisions, build order, dependency gates and acceptance tests.
- [Product checklist](docs/specs/product-checklist.md): 57 current acceptance items, including the replacement CRE requirements.
- [Reuse inventory](docs/research/reuse-inventory.md): inspected source paths and revisions, adaptations, known hazards and baseline-test results.

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
| 0G inference | Exact chat-completions URL, API key and model from your credited account; authorize an operating expense cap in settings |
| Uniswap | Public Sepolia RPC, server-side `ZERODEV_RPC_URL`, owner-created smart account, explicitly transferred test tokens and gas; delegation requires a bounded owner-signed session grant |
| Hyperliquid | Owner wallet and funded Hyperliquid testnet account; approve the separate agent address only if autonomous trading is wanted |
| 0G memory | Enable storage and explicitly fund the separate operating address with Galileo test tokens before requesting an encrypted upload |
| Chainlink CRE | Official CLI, its required build toolchain, authenticated CLI access and the workflow directory; see the workflow's own setup instructions |

Wallet connection is not trading authorization. Users retain their owner wallet; the application never asks for its seed phrase or private key. Agent and owner actions target the same supported account state, including existing Hyperliquid positions. Operating funds and trading capital are separate.

Uniswap execution uses a Kernel account with bounded call, expiry and gas policies. The backend's per-trade risk checks are additional controls. Hyperliquid's native agent grant is trading authority; our custom asset and notional limits are application-enforced, not falsely advertised as venue-native restrictions.

## Verification

```sh
npm run doctor
npm run typecheck
npm test
```

`doctor` checks configuration and performs read-only market requests. It does not submit transactions, upload storage objects or spend inference credits. An installed SDK or configured endpoint is not evidence of live authorization or successful execution.

The checklist remains the end-to-end acceptance record. Code implementation, local compile checks, public read connectivity and a funded owner-signed live demonstration are distinct milestones. Missing credentials and disabled integrations are surfaced instead of replaced with fabricated balances, fills or workflow results.

## Boundaries

- Sepolia, Hyperliquid testnet and Galileo only. Test tokens have no monetary value; testnet pool prices are not live-market valuations.
- CRE starts as actual local CLI simulation, orchestrated by our worker. It is not hosted DON execution and stops when its runner stops.
- No anonymous-read or private-trade claim. Private-only inference stays disabled until an attestation flow is verified; persistent memory is encrypted before upload.
- An operating expense cap is not a funded compute balance. Credit-balance and replenishment capabilities must be verified against the actual provider. No automatic top-up or earned-revenue loop is claimed without that evidence.
- There is no token launch, pooled trading vault or requirement to close all existing positions before connecting.
