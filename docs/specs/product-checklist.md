# Hackathon Product Checklist

Updated: 2026-11-05

Implementation checklist for this repository. IDs link to the [implementation plan](../plans/implementation-plan.md). All existing requirements are retained; source provenance is recorded separately in the [reuse inventory](../research/reuse-inventory.md).

Build a personal-agent trading platform where users can research, trade and manage positions themselves or through their authorized agent. Both interfaces operate on the same supported trading accounts. Privacy supports the product; it does not turn public trades into private transactions.

Sponsor targets: **0G + Uniswap + Ethereum Foundation**. Hyperliquid is an additional trading integration, not a fourth sponsor target.

This is the product acceptance checklist in build order. Unchecked means not yet verified end to end against this checklist, not necessarily missing from the existing code.

## 1. Wallet connection and personal agent

- [ ] `C1.1` Connect the user's wallet and load supported balances, positions and orders. Never request a seed phrase or private key.
- [ ] `C1.2` Create a personal agent with its own preferences, memory and separate signing credentials. Do not reuse one execution key across users.
- [ ] `C1.3` Create an agent operating wallet with a limited expense budget, separate from trading capital.
- [ ] `C1.4` Show the owner wallet, trading accounts and operating wallet distinctly. One dashboard does not imply one shared address across every venue.

## 2. User ownership and agent authorization

- [ ] `C2.1` Keep wallet connection separate from trading authorization. The user explicitly approves agent access in their wallet.
- [ ] `C2.2` For Uniswap, use a user-owned smart account with scoped agent permissions. Proposed implementation: ERC-4337 with Kernel's permission modules. Verify chain, account, router and signing compatibility before locking the implementation.
- [ ] `C2.3` Make smart-account funding an explicit user-approved action. Connecting an existing wallet does not transfer its tokens or grant control over them.
- [ ] `C2.4` For Hyperliquid, use native agent-wallet authorization for the user's existing account. Read positions using the trading account's address, not the agent signer's address.
- [ ] `C2.5` Provide permission review, expiry, revocation and key rotation. The agent cannot change ownership or grant itself broader permissions.
- [ ] `C2.6` Keep withdrawals and permission changes owner-controlled. Store agent credentials in protected signing infrastructure, never in model prompts, plaintext memory or public storage. Private inference does not itself secure wallet signing keys.
- [ ] `C2.7` Distinguish account-enforced restrictions from application-only risk limits. Do not claim Hyperliquid agent authorization natively enforces every custom per-trade limit.

## 3. Unified dashboard and manual trading

- [ ] `C3.1` Show balances, open positions, pending orders, P&L, recent activity and agent operating costs.
- [ ] `C3.2` Support manual Uniswap spot swaps with quote, approval, slippage, fee and confirmation states.
- [ ] `C3.3` Support manual Hyperliquid orders, cancellation, position reduction and closing, plus supported stop-loss and take-profit controls.
- [ ] `C3.4` Clearly distinguish spot holdings from leveraged positions. Selling a spot holding is not the same operation as closing a perpetual position.
- [ ] `C3.5` Display live, pending, failed and stale states accurately. Do not show an API acknowledgement as a confirmed fill.

## 4. Full agent capabilities

- [ ] `C4.1` Use 0G inference for meaningful research, analysis, planning and action selection, not merely narration around hard-coded trades.
- [ ] `C4.2` Let users request swaps, supported orders, position changes and explanations through conversation.
- [ ] `C4.3` Support both approval-required actions and autonomous execution within explicitly granted permissions.
- [ ] `C4.4` Let the agent manage manually opened positions in an authorized account, including supported positions opened outside our interface.
- [ ] `C4.5` Let users manually manage positions opened by the agent. Do not create separate user-only and agent-only portfolios.
- [ ] `C4.6` Require clarification or confirmation for ambiguous instructions such as "close it" when multiple positions could match.

## 5. Shared execution and safe handoff

- [ ] `C5.1` Route manual and agent actions through the same venue adapters, validation and account-state reconciliation.
- [ ] `C5.2` Check permissions outside the LLM. Validate account, asset, recipient, amount, slippage, expiry and supported action before signing.
- [ ] `C5.3` For EVM delegation, constrain actual transaction contents, not just a generic router address. Do not give a session key unrestricted router commands or token approvals.
- [ ] `C5.4` Refresh positions before modifying them. Use reduce-only orders for supported perpetual closing operations so a stale request cannot unintentionally reverse exposure.
- [ ] `C5.5` Prevent duplicate submissions and conflicting actions with account-level coordination, unique action IDs and venue-aware nonce handling.
- [ ] `C5.6` Provide Pause Agent and Take Over controls. Stop queued automation and reconcile pending actions; do not claim already-submitted transactions can always be cancelled.
- [ ] `C5.7` Record who initiated each action, the instruction, permission decision, resulting order or transaction and final status, without exposing secrets.

## 6. Background automation

- [ ] `C6.1` Run a background worker for monitoring, scheduled purchases, alerts and approved strategies. Automation must not depend on the browser remaining open.
- [ ] `C6.2` Show active, paused, expired, insufficient-budget and failed states for each automation.
- [ ] `C6.3` Define the caller, gas payer and retry policy for each execution. Avoid duplicate trades after a restart or timeout.
- [ ] `C6.4` Pause unsafe new actions on stale data, expired authorization or unavailable dependencies. Preserve manual controls and previously placed protective orders where the venue permits.

## 7. 0G inference and persistent memory

- [ ] `C7.1` Capture real 0G inference request IDs in the main agent workflow and show them in the technical demo.
- [ ] `C7.2` Verify the selected provider's private-inference mode and attestation path before labelling reasoning private or TEE-protected. Do not silently downgrade private requests.
- [ ] `C7.3` Encrypt persistent preferences, agent memory and sensitive execution context before uploading to 0G Storage. Keep decryption keys separate.
- [ ] `C7.4` Demonstrate memory retrieval after an agent restart. Avoid publicly publishing raw prompts, trading strategies or account mappings.
- [ ] `C7.5` Explain the dependency honestly: removing 0G stops the configured AI planning and analysis; manual trading should still be usable where its other dependencies are available.

## 8. Agent operating budget

- [ ] `C8.1` Let users explicitly fund a capped operating budget and inspect spending separately from trading performance.
- [ ] `C8.2` Track compute balance, expenditure, replenishment status and low-budget warnings. An onchain wallet balance is not automatically a spendable compute balance.
- [ ] `C8.3` Implement an authorized replenishment path into the actual 0G compute account, with spend caps and payment evidence. Never silently spend trading principal.
- [ ] `C8.4` Degrade safely or pause when the operating budget runs low. Do not promise that an agent runs forever without funding.
- [ ] `C8.5` If optional earned-funding mode is enabled, demonstrate genuine service revenue reaching the agent's compute account and paying for subsequent inference without manual top-ups. Only then describe it as self-sustaining.
- [ ] `C8.6` Do not require a token launch. Sponsor credits and owner deposits do not prove earned revenue.

## 9. Ethereum Foundation Anon-RPC

- [ ] `C9.1` Route supported browser blockchain reads through a real anonymizing worker by default. Never present the passthrough example as private.
- [ ] `C9.2` Verify balance, allowance and contract-state reads against the actual target RPCs through that worker.
- [ ] `C9.3` Confirm gateway access, RPC compatibility, bootstrap time and response latency on the demo network. Do not depend solely on a demonstration gateway with no availability guarantee.
- [ ] `C9.4` Show routing status and errors. Never silently fall back to direct requests while displaying a privacy-protected status.
- [ ] `C9.5` Document covered and uncovered traffic, including background-agent reads, wallet-provider traffic, Uniswap API requests and Hyperliquid APIs.
- [ ] `C9.6` Describe the protection accurately: reduced IP-to-wallet-query linkage at the destination RPC, not hidden trades, balances or positions on public ledgers.

## 10. Sponsor acceptance and demo

- [ ] `C10.1` **0G:** working judge-accessible agent flow, real request IDs, a concrete recurring use case and a demo under three minutes. Enter the self-sustaining bounty only if its complete earned-funding loop works.
- [ ] `C10.2` **Uniswap:** meaningful working swap integration, public open-source repo, integration code references, `FEEDBACK.md` and the required developer feedback form.
- [ ] `C10.3` **EF:** end-to-end anonymized reads, usable latency, demonstrated failure handling and an honest account of traffic coverage.
- [ ] `C10.4` Use supported testnet or local-fork routes for development and demonstration. Confirm venue compatibility and required balances without relying on mainnet funds.
- [ ] `C10.5` Demonstrate: user manually opens a position; agent reduces or closes that same position; user takes over again.
- [ ] `C10.6` Demonstrate: an agent-created position can be managed manually; expired or revoked permissions prevent subsequent agent actions.
- [ ] `C10.7` Demonstrate: conflicting actions, stale state, low operating budget and unavailable privacy routing produce understandable, safe outcomes.

## Scope boundaries

- No token launch, compulsory pooled vault or invented private-trading mode.
- No forced Hedera, Arkiv or extra sponsor integration.
- No claim that merely connecting a wallet authorizes the agent or makes every existing position controllable.
- No promise of arbitrary venue support. Add adapters without changing the ownership and permission model.
- Keep all manual and agent capabilities above in the hackathon product; these are build-order checkpoints, not a six-month release roadmap.

## Implementation references

- [Kernel permissions](https://docs.zerodev.app/smart-accounts/permissions/intro)
- [Hyperliquid API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)
- [Hyperliquid Exchange API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)
- [Uniswap developer documentation](https://developers.uniswap.org/docs)
- [Anon-RPC wallet integration](https://ethereum.github.io/anon-rpc/wallets/)
- [Tor gateway requirements](https://github.com/ethereum/tor-js/tree/main/crates/tor-js-gateway)

Sponsor acceptance items follow the supplied event track descriptions. These references support implementation choices; they are not application runtime configuration.
