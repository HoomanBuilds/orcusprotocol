import { encodeFunctionData, erc20Abi, type Address, type PublicClient } from "viem";
import { WalletActionError } from "./preflight";

type TransferClient = Pick<PublicClient, "readContract" | "simulateContract" | "estimateGas" | "estimateFeesPerGas" | "getBalance">;

export async function prepareOwnerTokenTransfer(client: TransferClient, input: { owner: Address; token: Address; recipient: Address; amount: bigint; maxGasCostWei?: bigint }) {
  const balance = await client.readContract({ address: input.token, abi: erc20Abi, functionName: "balanceOf", args: [input.owner] });
  if (balance < input.amount) throw new WalletActionError("INSUFFICIENT_FUNDS", "Your owner wallet does not have enough of the selected test token.");
  const { result: success } = await client.simulateContract({ account: input.owner, address: input.token, abi: erc20Abi, functionName: "transfer", args: [input.recipient, input.amount] });
  if (!success) throw new WalletActionError("PREFLIGHT_FAILED", "The test token rejected this transfer.");
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [input.recipient, input.amount] });
  const [estimate, fees] = await Promise.all([client.estimateGas({ account: input.owner, to: input.token, data }), client.estimateFeesPerGas()]);
  if (estimate <= 0n || estimate >= 1n << 64n || typeof fees.maxFeePerGas !== "bigint" || typeof fees.maxPriorityFeePerGas !== "bigint" || fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas || fees.maxFeePerGas >= 1n << 128n) throw new WalletActionError("PREFLIGHT_FAILED", "The transfer gas estimate or fee quote is invalid.");
  const gas = (estimate * 120n + 99n) / 100n, cost = gas * fees.maxFeePerGas;
  if (input.maxGasCostWei !== undefined && cost > input.maxGasCostWei) throw new WalletActionError("PREFLIGHT_FAILED", "The payment network fee exceeds the reviewed Sepolia ETH gas cap.");
  if (await client.getBalance({ address: input.owner }) < cost) throw new WalletActionError("INSUFFICIENT_GAS", "Your owner wallet needs Sepolia ETH for this transfer's network fee. Trading sponsorship does not cover external-wallet payments.");
  return { data, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
}
