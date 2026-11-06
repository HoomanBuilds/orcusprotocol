import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { WalletActionError } from "./preflight";

export const defaultOperationGasCapWei = "3000000000000000";
const entryPointBalanceAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export function assertSelfFundedOperation(operation: Record<string, unknown>, capWei = defaultOperationGasCapWei) {
  if (["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterAndData"].some(key => operation[key] !== undefined)) throw new WalletActionError("SPONSORSHIP_DISABLED", "Sponsorship is disabled. Prepare a new self-funded operation.");
  try {
    const quantity = (value: unknown) => {
      if (typeof value !== "bigint" && (typeof value !== "string" || !/^(?:0x[\da-f]+|\d+)$/iu.test(value))) throw new Error();
      const amount = BigInt(value as bigint | string);
      if (amount < 0n || amount >= 2n ** 128n) throw new Error();
      return amount;
    };
    const fee = quantity(operation.maxFeePerGas), priority = quantity(operation.maxPriorityFeePerGas);
    const gas = ["callGasLimit", "verificationGasLimit", "preVerificationGas"].reduce((sum, key) => sum + quantity(operation[key]), 0n);
    if (fee <= 0n || gas <= 0n || priority > fee || !/^[1-9]\d*$/u.test(capWei)) throw new Error();
    const cost = gas * fee;
    if (cost > BigInt(capWei)) throw new WalletActionError("GAS_LIMIT_EXCEEDED", "The maximum network fee exceeds the approved operation cap. Nothing was signed or submitted.");
    return cost;
  } catch (error) {
    if (error instanceof WalletActionError) throw error;
    throw new WalletActionError("INVALID_GAS_ESTIMATE", "The bundler did not return valid bounded gas and fee estimates. Nothing was submitted.");
  }
}

export function assertAvailableAccountGas(balance: bigint, deposit: bigint, maximumGas: bigint, callValue: bigint) {
  if (balance < 0n || deposit < 0n || maximumGas <= 0n || callValue < 0n) throw new WalletActionError("INVALID_GAS_ESTIMATE", "Invalid account gas balance or transfer value.");
  const shortfall = maximumGas > deposit ? maximumGas - deposit : 0n;
  if (balance < callValue + shortfall) throw new WalletActionError("SMART_ACCOUNT_GAS_INSUFFICIENT", "Fund your trading smart account with Sepolia ETH for the maximum network fee and any ETH being traded. The agent signing wallet does not pay this fee.");
}

export async function checkAccountGas(client: Pick<PublicClient, "getBalance" | "readContract">, sender: Address, operation: Record<string, unknown>, callValue: bigint, capWei = defaultOperationGasCapWei) {
  const cost = assertSelfFundedOperation(operation, capWei);
  if (getAddress(String(operation.sender)) !== getAddress(sender)) throw new WalletActionError("ACCOUNT_CHANGED", "The gas estimate is for a different trading account.");
  let balance: bigint, deposit: bigint;
  try {
    [balance, deposit] = await Promise.all([client.getBalance({ address: sender }), client.readContract({ address: entryPoint07Address, abi: entryPointBalanceAbi, functionName: "balanceOf", args: [sender] })]);
  } catch { throw new WalletActionError("GAS_BALANCE_UNAVAILABLE", "Could not verify the trading account's ETH and EntryPoint deposit. Nothing was submitted."); }
  assertAvailableAccountGas(balance, deposit, cost, callValue);
  return { maximumGasWei: cost, balanceWei: balance, entryPointDepositWei: deposit };
}
