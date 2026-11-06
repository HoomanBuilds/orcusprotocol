# Operator-funded gas sponsorship

`OrcusOperatorPaymaster` uses the maintained Account Abstraction 0.7 `BasePaymaster`, OpenZeppelin EIP-712, ECDSA, and two-step ownership. It does not replace Kernel or EntryPoint. It sponsors gas only; it does not own or move user trading assets.

## Build and local verification

```sh
npm run compile:paymaster
npm run test:contracts
ORCUS_FORK_BLOCK=12075208 npm run verify:operator-paymaster-fork
```

The fork command only writes to its isolated localhost Anvil instance. Use a recent pinned block or an archival source RPC when public RPC historical state is pruned. The proof deploys one paymaster locally, funds it with ephemeral Anvil ETH, and executes actual owner and delegated-agent Uniswap flows through the existing EntryPoint. It verifies the operator deposit pays all gas, account capital only pays explicit trade values, and invalid sponsorships fail. This does not prove compatibility with an external bundler or a public funded execution.

## Authorization format

The shared `@orcus/wallets/operator-paymaster` helper returns EIP-712 typed data, the authorization digest, and encoded `paymasterData`. Domain: `OrcusOperatorPaymaster`, version `1`, selected chain ID, verifying contract equal to this paymaster.

The signature binds sender, full nonce, factory and initialization data, account calldata, all account and paymaster gas limits, both fee fields, EntryPoint, validity range, and maximum sponsored cost. It excludes both the account signature and its own authorization signature. The account signs the complete UserOperation after sponsorship is attached.

EntryPoint 0.7 `paymasterAndData` is:

```text
paymaster address (20 bytes)
paymaster verification gas (16 bytes)
paymaster post-operation gas (16 bytes)
abi.encode(uint48 validUntil, uint48 validAfter, uint256 maxCost) (96 bytes)
ECDSA signature (65 bytes)
```

No infinite authorizations are accepted. Validity spans at most 300 seconds. EntryPoint enforces the returned validity timestamps and account nonce. Required prefund must be within both the signed cap and the owner's per-operation cap. An invalid fixed-size signature returns signature failure, allowing a bundler to estimate with a stub; it can never authorize execution. Malformed data and excessive costs fail closed.

## Deployment remains an explicit operator step

No public paymaster has been deployed or funded by these scripts. Constructor arguments are immutable EntryPoint, initial owner, authorization signer, and maximum cost in wei. The constructor checks the reference EntryPoint interface. Existing deployment target is Ethereum Sepolia, EntryPoint 0.7 at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`; independently verify code and chain before public deployment.

The platform wallet deposits ETH into the paymaster's EntryPoint deposit by calling `deposit()` with value. It is not enough to fund the signing EOA or send ETH directly to the paymaster. Because validation reads mutable signer and cost-limit storage, canonical [ERC-7562 storage rules](https://eips.ethereum.org/EIPS/eip-7562#storage-rules) require the paymaster to be staked. Use the inherited `addStake(uint32)` function with the chosen bundler's minimum stake and unstake delay. Do not assume a universal stake amount. Deposit pays gas; locked stake is a separate balance and does not pay gas. A compatible bundler endpoint and its successful admission/estimation check are still needed.

Runtime policy defaults to `ORCUS_GAS_SPONSOR_REQUIRE_STAKE=true` and `ORCUS_GAS_SPONSOR_MIN_UNSTAKE_DELAY_SECONDS=86400`. Set `ORCUS_GAS_SPONSOR_MIN_STAKE_WEI` to the selected provider's exact positive minimum; leaving it blank does not invent a universal amount or prove that provider's threshold. The server reads actual `EntryPoint.getDepositInfo`, checks it against the paymaster deposit getter, and rejects an absent, unlocking, zero or policy-insufficient stake before signing. Explicitly disabling the guard is only for a deliberately different local/private-bundler policy, not a canonical-admission claim. No automatic stake transaction is sent.

Use a separate admin multisig as owner and a limited hot authorization signer. Only the owner can withdraw the EntryPoint deposit, rotate the signer, or change the per-operation cap. Ownership transfers require acceptance and cannot be renounced accidentally. Rotating the signer invalidates outstanding approvals immediately. Server-side per-user, daily, and project quotas are separate from the onchain per-operation cap.

The signing key is trusted to spend the deposit within each operation cap. A compromised signer can drain that deposit through many permitted operations, so keep the deposit limited and monitor it. Sponsorship is an operator service and can be withheld without removing user ownership of their trading account. This implementation reuses maintained primitives and has local regression proofs, but is not independently security audited or certified.
