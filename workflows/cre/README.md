# CRE strategy workflow

This is a real Chainlink CRE TypeScript workflow built with `@chainlink/cre-sdk` and its WASM compiler. It is not a custom simulation presented as CRE. The managed Node worker invokes the official `cre workflow simulate` command once per due evaluation, validates the structured output and independently rechecks owner authority before any signing.

## Setup

Install the official [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation) and Bun. Authenticate the CLI with `cre login` or a configured `CRE_API_KEY`. Authentication and organization-enabled network access are external prerequisites; installing the binary does not grant them.

The project was checked against `cre init --non-interactive --project-name orcus-reference --deployment-registry private --workflow-name strategy --template hello-world-ts` from the official CLI. The temporary reference scaffold is ignored, not another shipped workflow. CRE CLI 1.39.0 and Bun 1.3.14 were verified on November 6, 2026; the skill documents Bun 1.2.21 as its minimum.

From this directory:

```sh
npm ci --prefix strategy
bun install --cwd strategy
cd strategy && bunx cre-setup && cd ..
npm run typecheck --prefix strategy
npm run build --prefix strategy
cre workflow simulate strategy --target local-simulation --non-interactive --trigger-index 0
cre workflow simulate strategy --target staging-settings --non-interactive --trigger-index 0
```

The build produces ignored `strategy/dist/workflow.wasm`. Both committed target configurations are visibly marked `local-simulation`: they fetch the actual Coinbase price, compare it with the clearly synthetic previous-price sample `1`, then return before creating an EVM client, receiver, report or transaction. They do not invent an authorized account or trade. CLI 1.39.0 requires an RPC entry even for this HTTP-only target, so `project.yaml` supplies the public Sepolia endpoint; the handler does not call it in this mode. This local target must never be selected for deployment or broadcast.

The application worker supplies a separate, short-lived strategy configuration with `--config`. That path uses real account observations and its own approved policy; it never consumes the sample price as trading state.

Configure the application:

```dotenv
CRE_ENABLED=true
CRE_CLI_PATH=/absolute/path/to/cre
CRE_WORKFLOW_DIR=/absolute/path/to/orcus-ethglobal/workflows/cre
CRE_TARGET=staging-settings
```

The parent process supplies CLI authentication but does not forward master signing keys or 0G inference credentials to the CLI child. Its timeout, output limit and durable scheduling remain application responsibilities. No `--broadcast` flag is used: only the normal permission-checked venue execution path can submit trades.

## Actual data flow

- A Uniswap job starts the independent Coinbase HTTP request and latest Sepolia header read before resolving either. It then reads the selected input asset's balance at that exact block through CRE's EVM capability. Native ETH input uses `balanceAt`; ordinary WETH/USDC inputs use `balanceOf`. Latest-state freshness is an intentional trading tradeoff; the execution worker rechecks current venue state and authorization before signing.
- A Hyperliquid job reads the actual testnet `clearinghouseState` via CRE HTTP. It does not pretend a Sepolia token balance is Hyperliquid collateral. The Uniswap path is the EVM-plus-external-data sponsor demonstration.
- The worker supplies its deduplicated 0G proposal and request ID as bounded evaluation input. If a separate proposal URL is configured, the workflow requests it with the secret `ORCUS_CRE_PROPOSAL_TOKEN` and checks the returned evaluation/request IDs. Configure the secret through CRE before using that optional path; do not put its value in JSON or committed YAML.
- Prices, thresholds, collateral and token balances use exact scaled integers rather than floating-point comparisons. Over-precision is rejected, not rounded. The complete typed proposal must match the approved candidate, including slippage, asset addresses, order IDs, reduction flags and leverage. QuickJS URL validation does not depend on an unavailable global `URL` constructor.
- Results are `allow`, `reject` or `no-action`, with account, policy, control revision, evaluation ID, expiry and observation evidence. A CRE allow is not wallet authorization. The application rechecks current permissions, risk limits, account state and idempotency before protected signing. Evaluation-run records have namespaced storage IDs so they cannot overwrite or block the evaluation's replay guard; old interrupted runs are migrated when recovered.
- Local result integrity comes from the trusted managed CLI/process boundary. It is not a DON signature and must not be accepted as a production hosted report.

## Current verification

Authenticated, non-broadcast CRE simulations passed on November 6, 2026. The standalone target printed this actual user log:

```text
ORCUS_CRE_LOCAL_RESULT={"mode":"local-simulation","currentPrice":"2222.8","previousPrice":"1","changed":true,"wouldWrite":false}
```

For the full application path, run from the repository root with a public observation account you select:

```sh
node --import tsx scripts/verify-cre.ts --account-address="$ORCUS_CRE_OBSERVATION_ACCOUNT"
```

The verification account must have at least 0.000001 native Sepolia ETH and no WETH for the specifically asserted allow/reject cases. Its private key is neither needed nor read. Five real CLI simulations proved:

- Native ETH candidate allowed with actual Sepolia block and balance evidence plus live Coinbase HTTP observations.
- WETH candidate rejected for the same account's observed zero WETH balance.
- An unmet price condition returned `no-action`.
- A changed slippage proposal was rejected before account reads.
- An actual durable-worker price alert consumed a real CLI result, persisted separate run/evaluation records, emitted one notification, survived reopening SQLite, and did not duplicate the next tick.

Representative actual observations were Sepolia block `12075420`, native balance `205843495264804705` wei, and price `2222.8` USD. These are dated evidence, not runtime defaults. The verifier made zero public-network writes and zero billable inference calls. It supplied a fixed typed candidate to test evaluation; this is not proof of a fresh 0G-generated proposal or a CRE-authorized trade reaching a public venue. Existing venue execution proofs are separate.

After installing the workflow dependencies above, `npm run test:cre` from the repository root runs capability-fixture tests for native versus token balance selection, exact decimals, proposal tampering and receiver-free local isolation. Fixture results are separate from the real CLI simulations. Server regression tests cover record-scope conflicts, interrupted-run migration and consumed-evaluation replay rejection.

The CLI is invoked with production-default limits. Managed calls to the same workflow directory are serialized within the application process: one evaluation runs, at most one waits, and additional calls return `CRE_RUNNER_BUSY` without starting a child process. Expiry is checked again after waiting. There are no automatic CLI execution retries. The official CLI writes a shared `.cre_build_tmp.js`; concurrent CLI invocations against one directory reproduced a missing-artifact compilation failure. Do not run a separate CLI simulation against the live worker's directory. Separate application processes need separate workflow directories or an external lease.

CLI failures return safe categories for a missing executable, timeout, output limit, missing shared artifact, compilation failure or authentication requirement. Raw stdout, stderr, account details and credentials are never forwarded in the error. Other failures remain fail-closed as `CRE_RUN_FAILED`.

The demo needs reachable API/RPC services and sufficient account access. The runner must stay running for conditional automation; stopping it pauses those jobs, while owner controls and venue-native protective orders stay separate.

Deployment access remains disabled for the verified account. `cre account access --help` was checked; the exact interactive request command is `cre account access`. The owner can describe the bounded trading-orchestration use case there and request Early Access. No access request, upload, deployment, activation, secret operation or broadcast was performed. A future hosted path needs explicit approval and authenticated report handling; a successful local simulation is not DON consensus.
