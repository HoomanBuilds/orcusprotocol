# Orcus ETHGlobal

A personal-agent trading platform where users and authorized agents manage the same supported trading accounts. Manual controls and agent capabilities share execution, permissions and position state. Users never share their wallet private keys.

Sponsor integrations: 0G inference and encrypted memory, Uniswap spot execution, and Ethereum Foundation Anon-RPC for supported browser reads. Hyperliquid supplies an additional trading venue.

## Project documentation

- [Implementation plan](docs/plans/implementation-plan.md): architecture, reuse decisions, build order, dependency gates and acceptance tests.
- [Product checklist](docs/specs/product-checklist.md): all 57 requirements with stable IDs.
- [Reuse inventory](docs/research/reuse-inventory.md): inspected source paths and revisions, adaptations, known hazards and baseline-test results.

## Current status

Planning documentation only. Application code has not yet been ported into this repository. The source audit is not proof that integrations work here, and checklist items remain unchecked until verified end to end.

Implementation will reuse selected existing code rather than rebuilding the applications wholesale. Development and demonstrations use test funds, supported testnets or explicitly identified local forks. No claim is made that public trades are private.
