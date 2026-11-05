import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { serializePermissionAccount } from "@zerodev/permissions";
import { createKernelAccount } from "@zerodev/sdk";
import type { PreparedAction } from "@orcus/core";
import { createWalletClient, custom, getAddress, isHex, type Chain, type EIP1193Provider, type Hex } from "viem";
import { arbitrumSepolia, sepolia } from "viem/chains";
import { createOwnerKernel, createPermissionPlugin, entryPoint, kernelVersion, kernelGrantPolicySchema, type KernelAuthorization, type KernelConfig, type KernelGrantPolicy } from "./kernel";

function provider(): EIP1193Provider {
  if (typeof window === "undefined") throw new Error("Connect a wallet in your browser.");
  const ethereum = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (!ethereum) throw new Error("Install an Ethereum wallet extension to continue.");
  return ethereum;
}

export async function connectWallet() {
  const addresses = await provider().request({ method: "eth_requestAccounts" });
  if (!addresses[0]) throw new Error("No wallet account was selected.");
  return getAddress(addresses[0]);
}

export async function currentWalletAddress() {
  const addresses = await provider().request({ method: "eth_accounts" });
  if (!addresses[0]) throw new Error("Connect your owner wallet first.");
  return getAddress(addresses[0]);
}

async function ownerWallet(chain: Chain = sepolia) {
  const account = await currentWalletAddress();
  const wallet = createWalletClient({ account, chain, transport: custom(provider()) });
  if (await wallet.getChainId() !== chain.id) await wallet.switchChain({ id: chain.id });
  if (await wallet.getChainId() !== chain.id) throw new Error(`Switch your wallet to ${chain.name}.`);
  return wallet;
}

export async function signLoginMessage(message: string): Promise<Hex> {
  const account = await currentWalletAddress();
  const wallet = createWalletClient({ account, transport: custom(provider()) });
  return wallet.signMessage({ account, message });
}

async function browserKernelConfig(): Promise<KernelConfig> {
  const response = await fetch("/api/wallet-config", { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.data?.smartAccountsConfigured) throw new Error(result.error?.message ?? "Configure the testnet bundler before creating a trading account.");
  return { rpcUrl: new URL(result.data.rpcUrl, window.location.origin).href, bundlerUrl: new URL(result.data.bundlerUrl, window.location.origin).href };
}

export async function createTradingSmartAccount() {
  const wallet = await ownerWallet();
  const kernel = await createOwnerKernel(await browserKernelConfig(), wallet);
  return { address: kernel.account.address, chainId: sepolia.id };
}

export async function approveHyperliquidAgent(agentAddress: string, agentName = "Orcus") {
  const wallet = await ownerWallet(arbitrumSepolia);
  const client = new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet, signatureChainId: "0x66eee" });
  return client.approveAgent({ agentAddress: getAddress(agentAddress), agentName: agentName.slice(0, 16) });
}

export async function executePreparedAction(prepared: PreparedAction): Promise<{ transactionHash?: string; userOperationHash?: string; orderId?: string; response?: unknown }> {
  if (prepared.expiresAt <= Date.now()) throw new Error("This quote expired. Refresh it before signing.");
  const owner = await currentWalletAddress();
  if (getAddress(prepared.account.ownerAddress) !== owner) throw new Error("Your wallet changed. Reconnect the account owner before trading.");
  if (prepared.account.venue === "hyperliquid") {
    if (!prepared.hyperliquid || prepared.kind !== "hyperliquid") throw new Error("The venue request is missing.");
    const wallet = await ownerWallet(arbitrumSepolia);
    const exchange = new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet, signatureChainId: "0x66eee", defaultExpiresAfter: prepared.expiresAt });
    const operation = prepared.hyperliquid;
    let response: unknown;
    if (operation.method === "order") response = await exchange.order(operation.params as Parameters<typeof exchange.order>[0]);
    else if (operation.method === "cancel") response = await exchange.cancel(operation.params as Parameters<typeof exchange.cancel>[0]);
    else if (operation.method === "cancelByCloid") response = await exchange.cancelByCloid(operation.params as Parameters<typeof exchange.cancelByCloid>[0]);
    else if (operation.method === "updateLeverage") response = await exchange.updateLeverage(operation.params as Parameters<typeof exchange.updateLeverage>[0]);
    else throw new Error("Unsupported venue operation.");
    const statuses = (response as { response?: { data?: { statuses?: Array<{ resting?: { oid: number }; filled?: { oid: number }; error?: string }> } } }).response?.data?.statuses;
    const error = statuses?.find(status => status.error)?.error;
    if (error) throw new Error(error);
    const orderId = statuses?.map(status => status.resting?.oid ?? status.filled?.oid).find(id => id !== undefined);
    return { orderId: orderId === undefined ? undefined : String(orderId), response };
  }
  if (prepared.account.chainId !== sepolia.id || !prepared.transactions?.length) throw new Error("This is not a supported Sepolia swap.");
  const kernel = await createOwnerKernel(await browserKernelConfig(), await ownerWallet());
  if (getAddress(kernel.account.address) !== getAddress(prepared.account.address)) throw new Error("The prepared trading account does not belong to this wallet.");
  const calls = prepared.transactions.map(tx => {
    if (tx.chainId !== sepolia.id || !isHex(tx.data)) throw new Error("Invalid testnet transaction.");
    return { to: getAddress(tx.to), data: tx.data as Hex, value: BigInt(tx.value) };
  });
  const hash = await kernel.client.sendUserOperation({ callData: await kernel.account.encodeCalls(calls) });
  const recorded = await fetch("/api/actions/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId: prepared.id, userOperationHash: hash }),
  }).catch(() => undefined);
  if (!recorded?.ok) throw new Error(`User operation ${hash} was submitted, but recording its pending status failed. Check account activity before retrying.`);
  const receipt = await kernel.client.waitForUserOperationReceipt({ hash, timeout: 120_000 });
  if (!receipt.success) throw new Error("The swap was submitted but reverted. Check activity before retrying.");
  return { transactionHash: receipt.receipt.transactionHash, userOperationHash: hash, response: { userOperationHash: hash } };
}

export async function grantKernelPermission(input: KernelGrantPolicy): Promise<KernelAuthorization> {
  const policy = kernelGrantPolicySchema.parse(input);
  if (policy.expiresAt <= Date.now() || policy.issuedAt > Date.now() + 10_000) throw new Error("Permission validity is incorrect.");
  const config = await browserKernelConfig();
  const owner = await createOwnerKernel(config, await ownerWallet());
  if (getAddress(owner.account.address) !== getAddress(policy.accountAddress)) throw new Error("This permission targets a different trading account.");
  const regular = await createPermissionPlugin(config, policy);
  const account = await createKernelAccount(owner.publicClient, { entryPoint, kernelVersion, plugins: { sudo: owner.sudo, regular } });
  const approval = await serializePermissionAccount(account);
  return { approval, policy };
}

export async function revokeKernelPermission(policy: KernelGrantPolicy) {
  const config = await browserKernelConfig();
  const owner = await createOwnerKernel(config, await ownerWallet());
  if (getAddress(owner.account.address) !== getAddress(policy.accountAddress)) throw new Error("This permission targets a different account.");
  const plugin = await createPermissionPlugin(config, policy);
  const hash = await owner.client.uninstallPlugin({ plugin });
  const receipt = await owner.client.waitForUserOperationReceipt({ hash, timeout: 120_000 });
  if (!receipt.success) throw new Error("Permission revocation reverted. Do not assume the agent key is revoked.");
  return receipt.receipt.transactionHash;
}
