# Orcus ETHGlobal

A personal-agent trading platform where users and authorized agents manage the same supported trading accounts. Manual controls and agent capabilities share execution, permissions and position state. Users never share their wallet private keys.

Sponsor targets: 0G inference and encrypted memory, Uniswap spot execution, and Chainlink CRE for conditional strategy orchestration. Hyperliquid supplies an additional trading venue. CRE starts in local simulation with real testnet/API calls and a managed runner; this is not hosted DON execution.

## Project documentation

- [Implementation plan](docs/plans/implementation-plan.md): architecture, reuse decisions, build order, dependency gates and acceptance tests.
- [Product checklist](docs/specs/product-checklist.md): 57 current acceptance items, including the replacement CRE requirements.
- [Reuse inventory](docs/research/reuse-inventory.md): inspected source paths and revisions, adaptations, known hazards and baseline-test results.

## Current status

Planning documentation only. Application code has not yet been ported into this repository. The source audit is not proof that integrations work here, and checklist items remain unchecked until verified end to end.

Implementation will reuse selected existing code rather than rebuilding the applications wholesale. Development and demonstrations use test funds, supported testnets or explicitly identified local forks. No claim is made that public trades are private.
