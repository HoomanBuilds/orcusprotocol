import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, isAddressEqual, parseAbi, zeroAddress, type Hex } from "viem";
import type { EvmTransaction, TradingAccount } from "@orcus/core";
import { OSTIUM_TESTNET } from "@orcus/wallets/ostium";
import { decimalToAtoms } from "../hyperliquid/wire-format";
import { EngineError } from "../../errors";
import { boundedOstiumRead, getOstiumAuthorization, ostiumSdk, verifiedOstiumRpc } from "./client";
import { assertOstiumAccount } from "./data";

const same = (a: string, b: string) => isAddressEqual(getAddress(a), getAddress(b));

export async function getOstiumApprovalTransaction(account: TradingAccount, amountUsd: string) {
  assertOstiumAccount(account);
  const amount = decimalToAtoms(amountUsd, 6);
  if (amount <= 0n || amount > 2_000_000_000_000n) throw new EngineError("INVALID_AMOUNT", "Approve an exact positive USDC allowance no larger than the supported collateral cap.");
  const rpc = await verifiedOstiumRpc(), minimumBlock = (await rpc.getBlockNumber()).toString();
  const client = await ostiumSdk(account.address), built = client.getApproveUsdcTx(amountUsd);
  if (built.kind !== "eoa" || built.value !== 0n || !same(built.from, account.ownerAddress) || !same(built.to, OSTIUM_TESTNET.usdc) || built.data !== encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OSTIUM_TESTNET.storage, amount] })) throw new EngineError("OSTIUM_CALL_MISMATCH", "The allowance request does not match the reviewed exact testnet approval.");
  const balances = await boundedOstiumRead(() => client.getBalances(getAddress(account.address)));
  return { trader: account.address, chainId: 421614 as const, token: OSTIUM_TESTNET.usdc, spender: OSTIUM_TESTNET.storage, amountUsd, amountRaw: amount.toString(), transaction: { to: built.to, data: built.data, value: "0", chainId: 421614, label: `Approve exactly ${amountUsd} Ostium testnet USDC` }, previousAllowanceUsd: balances.allowance, minimumBlock, expiresAt: Date.now() + 120_000 };
}

export async function reconcileOstiumApproval(input: { transactionHash: string; account: TradingAccount; amountUsd: string; notBefore?: number; minimumBlock?: string; expectedTransaction?: EvmTransaction }) {
  assertOstiumAccount(input.account);
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new EngineError("INVALID_TRANSACTION", "A valid transaction hash is required.");
  const rpc = await verifiedOstiumRpc(); let amount = decimalToAtoms(input.amountUsd, 6); const hash = input.transactionHash as Hex;
  if (input.expectedTransaction) {
    const expected = input.expectedTransaction;
    if (expected.chainId !== 421614 || expected.value !== "0" || !same(expected.to, OSTIUM_TESTNET.usdc)) throw new EngineError("APPROVAL_NOT_VERIFIED", "The expected allowance step does not match Ostium testnet.");
    const decoded = decodeFunctionData({ abi: erc20Abi, data: expected.data as Hex });
    if (decoded.functionName !== "approve" || !same(decoded.args[0], OSTIUM_TESTNET.storage) || decoded.args[1] !== 0n && decoded.args[1] !== amount) throw new EngineError("APPROVAL_NOT_VERIFIED", "The expected allowance exceeds the approved amount.");
    amount = decoded.args[1];
  }
  const receipt = await rpc.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return { status: "pending" as const, transactionHash: hash, evidence: { receipt: "unavailable" } };
  if (receipt.status !== "success") return { status: "rejected" as const, transactionHash: hash, evidence: { receipt: "reverted" } };
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber }), blockTimestamp = Number(block.timestamp) * 1000;
  if (input.minimumBlock !== undefined ? !/^\d+$/.test(input.minimumBlock) || receipt.blockNumber <= BigInt(input.minimumBlock) : input.notBefore !== undefined && blockTimestamp < Math.floor(input.notBefore / 1000) * 1000) throw new EngineError("APPROVAL_NOT_VERIFIED", "This approval predates its recorded owner intent.");
  const transaction = await rpc.getTransaction({ hash });
  const expected = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OSTIUM_TESTNET.storage, amount] });
  if (!same(transaction.from, input.account.ownerAddress) || !transaction.to || !same(transaction.to, OSTIUM_TESTNET.usdc) || transaction.value !== 0n || transaction.input !== expected) throw new EngineError("APPROVAL_NOT_VERIFIED", "The receipt does not match this owner's exact Ostium allowance.");
  const events = receipt.logs.flatMap(log => {
    if (!same(log.address, OSTIUM_TESTNET.usdc)) return [];
    try { const event = decodeEventLog({ abi: erc20Abi, ...log }); return event.eventName === "Approval" && same(event.args.owner, input.account.ownerAddress) && same(event.args.spender, OSTIUM_TESTNET.storage) && event.args.value === amount ? [event] : []; } catch { return []; }
  });
  if (events.length !== 1) throw new EngineError("APPROVAL_NOT_VERIFIED", "The receipt does not uniquely prove this exact USDC allowance.");
  return { status: "confirmed" as const, transactionHash: hash, evidence: { blockNumber: receipt.blockNumber.toString(), blockTimestamp, amountRaw: amount.toString(), owner: input.account.ownerAddress, spender: OSTIUM_TESTNET.storage, token: OSTIUM_TESTNET.usdc } };
}

export async function getOstiumDelegationTransactions(account: TradingAccount, delegate: string | null) {
  assertOstiumAccount(account);
  const target = delegate === null ? zeroAddress : getAddress(delegate);
  if (delegate !== null && same(target, zeroAddress)) throw new EngineError("INVALID_AGENT", "Choose a nonzero delegate address.");
  const current = await getOstiumAuthorization({ trader: account.address, chainId: account.chainId });
  if (delegate !== null && !same(current.delegate, zeroAddress) && !same(current.delegate, target)) throw new EngineError("OSTIUM_EXISTING_DELEGATE", "This account already authorizes a different delegate. The owner must revoke it explicitly before registering Orcus.", 409);
  const alreadyActive = same(current.delegate, target), transactions = [];
  if (!alreadyActive) {
    const client = await ostiumSdk(account.address), built = delegate === null ? client.getRemoveDelegateTx({ from: "trader" }) : client.getSetDelegateTx(target, { from: "trader" });
    const expected = delegate === null ? encodeFunctionData({ abi: parseAbi(["function removeDelegate()"]), functionName: "removeDelegate" }) : encodeFunctionData({ abi: parseAbi(["function setDelegate(address delegate)"]), functionName: "setDelegate", args: [target] });
    if (built.kind !== "eoa" || !same(built.from, account.ownerAddress) || !same(built.traderAddress, account.ownerAddress) || !same(built.to, OSTIUM_TESTNET.trading) || built.value !== 0n || built.data !== expected) throw new EngineError("OSTIUM_CALL_MISMATCH", "Only the owner can sign this exact native grant or revocation.");
    transactions.push({ to: built.to, data: built.data, value: "0", chainId: 421614, label: delegate === null ? "Revoke the native Ostium delegate" : "Register the reviewed native Ostium delegate" });
  }
  return { trader: account.address, delegate: target, chainId: 421614 as const, contractAddress: OSTIUM_TESTNET.trading, currentDelegate: current.delegate, implementation: current.implementation, transactions, expiresAt: Date.now() + 120_000, alreadyActive };
}
