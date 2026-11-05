# CRE strategy workflow

This is a real Chainlink CRE TypeScript workflow built with `@chainlink/cre-sdk` and its WASM compiler. It is not a custom simulation presented as CRE. The managed Node worker invokes the official `cre workflow simulate` command once per due evaluation, validates the structured output and independently rechecks owner authority before any signing.

## Setup

Install the official [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation) and Bun. Authenticate the CLI with `cre login` or a configured `CRE_API_KEY`. Authentication and organization-enabled network access are external prerequisites; installing the binary does not grant them.

From this directory:

```sh
npm ci --prefix strategy
npm run typecheck --prefix strategy
npm run build --prefix strategy
```

The build produces ignored `strategy/dist/workflow.wasm`. Compilation does not prove a successful network simulation. The committed sample configuration deliberately has no authorized user account or valid evaluation window. The application worker generates the real, short-lived configuration; do not change the sample to fabricate successful user activity.

Configure the application:

```dotenv
CRE_ENABLED=true
CRE_CLI_PATH=/absolute/path/to/cre
CRE_WORKFLOW_DIR=/absolute/path/to/orcus-ethglobal/workflows/cre
CRE_TARGET=staging-settings
```

The parent process supplies CLI authentication but does not forward master signing keys or 0G inference credentials to the CLI child. Its timeout, output limit and durable scheduling remain application responsibilities. No `--broadcast` flag is used: only the normal permission-checked venue execution path can submit trades.

## Actual data flow

- A Uniswap job reads the latest Sepolia header and the selected input token's balance at that block through CRE's EVM capability. It checks balance and observation freshness, then combines those observations with a real Coinbase price response through the HTTP capability.
- A Hyperliquid job reads the actual testnet `clearinghouseState` via CRE HTTP. It does not pretend a Sepolia token balance is Hyperliquid collateral. The Uniswap path is the EVM-plus-external-data sponsor demonstration.
- The worker supplies its deduplicated 0G proposal and request ID as bounded evaluation input. If a separate proposal URL is configured, the workflow requests it with the secret `ORCUS_CRE_PROPOSAL_TOKEN` and checks the returned evaluation/request IDs. Configure the secret through CRE before using that optional path; do not put its value in JSON or committed YAML.
- Results are `allow`, `reject` or `no-action`, with account, policy, control revision, evaluation ID, expiry and observation evidence. A CRE allow is not wallet authorization. The application rechecks current permissions, risk limits, account state and idempotency before protected signing.
- Local result integrity comes from the trusted managed CLI/process boundary. It is not a DON signature and must not be accepted as a production hosted report.

## Current verification

The workflow passed TypeScript checking and the official WASM build without skipped typechecks. Live CLI initialization/simulation was blocked by missing CRE authentication in the implementation environment. No successful simulation, hosted deployment, fee entitlement or real trade is claimed until separately demonstrated with authorized test accounts.

The CLI is invoked with production-default limits. The demo needs reachable API/RPC services and sufficient account access. The runner must stay running for conditional automation; stopping it pauses those jobs, while owner controls and venue-native protective orders stay separate.
