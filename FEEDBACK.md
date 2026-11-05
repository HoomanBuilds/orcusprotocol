# Uniswap Integration Feedback

## Integration

The application uses Uniswap V3 on Sepolia for owner-initiated and scoped-agent spot execution. The relevant implementation is `agent/src/venues/uniswap/index.ts`, with Kernel signing and call policies in `packages/wallets/src/`.

- Quote through QuoterV2 with onchain token decimals and a factory-resolved pool.
- Encode SwapRouter02 `exactInputSingle` inside a one-call deadline multicall.
- Approve a bounded token amount, preserve minimum output and reconcile settlement against the account's operation and token-transfer evidence.
- Keep token balances in the user's trading account rather than a shared application vault.

## What worked

The published Sepolia deployment table provided the factory, router and quoter needed for the direct integration. Read-only checks returned a real quote for the supported WETH/USDC pool. The integration does not require a separate Trading API key.

## Friction

Router variants need particularly clear labeling. Original SwapRouter and SwapRouter02 use different `exactInputSingle` tuples; the latter requires a deadline-protected wrapper instead of adding an unsupported field to the tuple. A concise example covering that distinction, contract-wallet batching and exact allowance behavior would reduce integration mistakes.

Testnet prices and liquidity must also be distinguished from live market valuations in sample interfaces. A successful quote does not establish a useful mainnet reference price.

## Verification still required

Owner/session execution needs configured bundler access, explicit user funding and a signed live demonstration. Do not treat the read-only quote check as evidence that those steps already occurred. The required developer feedback form must be submitted separately with this file's public URL.
