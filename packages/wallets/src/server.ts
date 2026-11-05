import type { PreparedAction } from "@orcus/core";
import { deserializePermissionAccount, type PermissionAccountParams } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { getAddress, http, isHex, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createOwnerKernel, createPermissionPlugin, entryPoint, kernelVersion, kernelPublicClient, kernelGrantPolicySchema, type KernelAuthorization, type KernelConfig } from "./kernel";

function config(): KernelConfig {
  if (!process.env.ZERODEV_RPC_URL) throw new Error("Set ZERODEV_RPC_URL for the Sepolia bundler.");
  return { rpcUrl: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com", bundlerUrl: process.env.ZERODEV_RPC_URL };
}

const canonical = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);

export async function verifyKernelEnrollment(input: { ownerAddress: string; smartAccountAddress: string; agentAddress: string; authorization: KernelAuthorization }): Promise<boolean> {
  try {
    const { approval } = input.authorization;
    if (approval.length > 100_000) return false;
    const policy = kernelGrantPolicySchema.parse(input.authorization.policy);
    if (policy.expiresAt <= Date.now() || policy.issuedAt > Date.now() + 10_000 || policy.issuedAt < Date.now() - 600_000) return false;
    if (getAddress(policy.accountAddress) !== getAddress(input.smartAccountAddress) || getAddress(policy.agentAddress) !== getAddress(input.agentAddress)) return false;
    const parsed = JSON.parse(Buffer.from(approval, "base64").toString("utf8")) as PermissionAccountParams;
    if (parsed.privateKey || parsed.eip7702Auth || parsed.isPreInstalled || !parsed.enableSignature) return false;
    const owner = await createOwnerKernel(config(), getAddress(input.ownerAddress));
    if (getAddress(owner.account.address) !== getAddress(input.smartAccountAddress) || getAddress(parsed.accountParams.accountAddress) !== getAddress(owner.account.address)) return false;
    const regular = await createPermissionPlugin(config(), policy);
    const account = await createKernelAccount(owner.publicClient, { entryPoint, kernelVersion, plugins: { sudo: owner.sudo, regular } });
    if (canonical(parsed.permissionParams) !== canonical(regular.getPluginSerializationParams())) return false;
    if (canonical(parsed.action) !== canonical(account.kernelPluginManager.getAction()) || canonical(parsed.validityData) !== canonical(account.kernelPluginManager.getValidityData())) return false;
    if (parsed.accountParams.initCode.toLowerCase() !== (await account.generateInitCode()).toLowerCase()) return false;
    const typedData = await account.kernelPluginManager.getPluginsEnableTypedData(account.address);
    return verifyTypedData({ ...typedData, address: getAddress(input.ownerAddress), signature: parsed.enableSignature });
  } catch { return false; }
}

export async function submitKernelSessionAction(prepared: PreparedAction, key: Hex, authorization: KernelAuthorization, onSubmitted?: (evidence: { userOperationHash: string }) => Promise<void> | void) {
  if (!prepared.transactions?.length || prepared.account.chainId !== sepolia.id || prepared.expiresAt <= Date.now()) throw new Error("The prepared Sepolia swap is missing or expired.");
  const policy = kernelGrantPolicySchema.parse(authorization.policy);
  const signerAccount = privateKeyToAccount(key);
  if (getAddress(signerAccount.address) !== getAddress(policy.agentAddress) || getAddress(prepared.account.address) !== getAddress(policy.accountAddress) || policy.expiresAt <= Date.now()) throw new Error("The session authority does not match this account.");
  const parsed = JSON.parse(Buffer.from(authorization.approval, "base64").toString("utf8")) as PermissionAccountParams;
  if (parsed.privateKey || parsed.eip7702Auth || parsed.isPreInstalled) throw new Error("Unsupported serialized session authority.");
  const network = config();
  const publicClient = kernelPublicClient(network);
  const signer = await toECDSASigner({ signer: signerAccount });
  const account = await deserializePermissionAccount(publicClient, entryPoint, kernelVersion, authorization.approval, signer);
  if (getAddress(account.address) !== getAddress(prepared.account.address)) throw new Error("Serialized session account mismatch.");
  const client = createKernelAccountClient({ account, chain: sepolia, client: publicClient, bundlerTransport: http(network.bundlerUrl, { retryCount: 0, timeout: 30_000 }) });
  const calls = prepared.transactions.map(tx => {
    if (tx.chainId !== sepolia.id || !isHex(tx.data) || BigInt(tx.value) !== 0n) throw new Error("Session swaps cannot transfer native value.");
    return { to: getAddress(tx.to), data: tx.data as Hex, value: 0n };
  });
  const hash = await client.sendUserOperation({ callData: await account.encodeCalls(calls) });
  await onSubmitted?.({ userOperationHash: hash });
  const receipt = await client.waitForUserOperationReceipt({ hash, timeout: 120_000 });
  return { transactionHash: receipt.receipt.transactionHash, userOperationHash: hash, status: receipt.success ? "confirmed" : "rejected" };
}
