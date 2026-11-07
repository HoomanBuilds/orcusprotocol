import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { BrowserProvider, type TypedDataDomain, type TypedDataField } from "ethers";
import { serializePermissionAccount } from "@zerodev/permissions";
import { createKernelAccount, KernelV3_1AccountAbi } from "@zerodev/sdk";
import { ostiumDelegationAcknowledgementSchema, type EvmTransaction, type PreparedAction, type TradingAccount } from "@orcus/core";
import { BaseError, concatHex, createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, erc20Abi, getAddress, http, padHex, zeroAddress, type Address, type Chain, type EIP1193Provider, type Hex } from "viem";
import { formatUserOperationRequest, getUserOperationHash } from "viem/account-abstraction";
import { arbitrumSepolia, sepolia } from "viem/chains";
import { createOwnerKernel, createPermissionPlugin, entryPoint, kernelVersion, kernelPublicClient, kernelGrantPolicySchema, type KernelAuthorization, type KernelConfig, type KernelGrantPolicy } from "./kernel";
import { exactTokenAmount, inspectPreparedSwap, isOwnerRejection, WalletActionError } from "./preflight";
import { broadcastPreparedOperation } from "./execution";
import { checkAccountGas, defaultOperationGasCapWei } from "./self-funded-gas";
import { prepareOwnerTokenTransfer } from "./token-transfer";
import { assertOstiumOwnerDeployment, executeOstiumOwnerAction } from "./ostium-owner";
import { OSTIUM_TESTNET, inspectOstiumOwnerPlan, inspectPreparedOstiumAction, ostiumTradingAbi, type OstiumAllowancePlan, type OstiumDelegationPlan } from "./ostium";

export { WalletActionError } from "./preflight";

const galileo = defineChain({ id: 16602, name: "0G Galileo Testnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: ["https://evmrpc-testnet.0g.ai"] } }, blockExplorers: { default: { name: "0G ChainScan", url: "https://chainscan-galileo.0g.ai" } }, testnet: true });

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

async function assertOwner(expected: string, chain?: Chain) {
  if (await currentWalletAddress() !== getAddress(expected)) throw new WalletActionError("OWNER_CHANGED", "Your wallet account changed. Reconnect the account owner before signing.");
  if (chain && Number(await provider().request({ method: "eth_chainId" })) !== chain.id) throw new WalletActionError("NETWORK_CHANGED", `Switch your wallet to ${chain.name} before signing.`);
}

async function ownerWallet(chain: Chain = sepolia, expected?: string) {
  const account = await currentWalletAddress();
  if (expected && account !== getAddress(expected)) throw new WalletActionError("OWNER_CHANGED", "Reconnect the account owner before continuing.");
  const wallet = createWalletClient({ account, chain, transport: custom(provider()) });
  if (await wallet.getChainId() !== chain.id) {
    try { await wallet.switchChain({ id: chain.id }); }
    catch (error) {
      const missingChain = error instanceof BaseError ? error.walk(cause => cause !== null && typeof cause === "object" && "code" in cause && cause.code === 4902) : error && typeof error === "object" && "code" in error && error.code === 4902;
      if (!missingChain) throw error;
      await assertOwner(account);
      await wallet.addChain({ chain });
      await wallet.switchChain({ id: chain.id });
    }
  }
  if (await wallet.getChainId() !== chain.id) throw new Error(`Switch your wallet to ${chain.name}.`);
  await assertOwner(account, chain);
  return wallet;
}

async function accountControl(account: TradingAccount, revision = account.controlRevision) {
  await assertOwner(account.ownerAddress);
  const response = await fetch("/api/session", { cache: "no-store" });
  const result = await response.json();
  const current = (result.data?.accounts as TradingAccount[] | undefined)?.find(item => item.id === account.id);
  if (!response.ok || !result.data?.user || getAddress(result.data.user.address) !== getAddress(account.ownerAddress) || !current || getAddress(current.ownerAddress) !== getAddress(account.ownerAddress) || getAddress(current.address) !== getAddress(account.address) || current.chainId !== account.chainId || current.venue !== account.venue || current.controlRevision !== revision || current.status === "unsupported") throw new WalletActionError("ACCOUNT_CHANGED", "Your session or trading account changed. Refresh before signing.");
}

export async function signLoginMessage(message: string): Promise<Hex> {
  const account = await currentWalletAddress();
  const wallet = createWalletClient({ account, transport: custom(provider()) });
  return wallet.signMessage({ account, message });
}

async function browserKernelConfig(scope?: { actionId?: string; accountAddress?: string; purpose?: string }): Promise<KernelConfig> {
  const response = await fetch("/api/wallet-config", { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.data?.rpcUrl) throw new Error(result.error?.message ?? "The testnet wallet configuration is unavailable.");
  const proxy = (value: string) => {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password) throw new WalletActionError("WALLET_CONFIG_INVALID", "Wallet execution requires the authenticated platform proxies. Nothing was submitted.");
    return url;
  };
  const bundlerUrl = proxy(result.data.bundlerUrl ?? "/api/bundler");
  for (const [key, value] of Object.entries(scope ?? {})) if (value) bundlerUrl.searchParams.set(key, value);
  return { rpcUrl: proxy(result.data.rpcUrl).href, bundlerUrl: bundlerUrl.href, maxOperationGasWei: result.data.gasPayment?.maxOperationGasWei ?? defaultOperationGasCapWei };
}

export async function createTradingSmartAccount() {
  const wallet = await ownerWallet();
  const kernel = await ownerKernel(await browserKernelConfig(), wallet.account.address);
  return { address: kernel.account.address, chainId: sepolia.id };
}

async function ownerKernel(config: KernelConfig, ownerAddress: string) {
  const wallet = await ownerWallet(sepolia, ownerAddress);
  const code = await kernelPublicClient(config).getCode({ address: wallet.account.address });
  if (code && code !== "0x" && !code.startsWith("0xef0100")) throw new WalletActionError("OWNER_TYPE_UNSUPPORTED", "This Kernel setup currently requires an EOA owner. Multisig contract owners need a separate validator integration.");
  await assertOwner(ownerAddress, sepolia);
  return createOwnerKernel(config, wallet);
}

async function recordSubmission(actionId: string, evidence: Record<string, unknown>) {
  const response = await fetch("/api/actions/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionId, ...evidence }) });
  if (!response.ok) throw new Error("The pending submission could not be recorded.");
}

async function sendOwnerOperation(owner: Awaited<ReturnType<typeof createOwnerKernel>>, calls: Array<{ to: Address; data: Hex; value: bigint }>, assertReady: () => Promise<void>, onSubmitted?: (evidence: { userOperationHash: string }) => Promise<void>) {
  let operation;
  try { operation = await owner.client.prepareUserOperation({ callData: await owner.account.encodeCalls(calls) }); }
  catch { throw new WalletActionError("PREFLIGHT_FAILED", "Bundler simulation or fee estimation failed. Fund your trading smart account with Sepolia ETH and check the reviewed action. Nothing was submitted."); }
  const checkGas = () => checkAccountGas(owner.publicClient, owner.account.address, operation, calls.reduce((sum, call) => sum + call.value, 0n), owner.maxOperationGasWei);
  await checkGas();
  await assertReady();
  await checkGas();
  let signature: Hex;
  try { signature = await owner.account.signUserOperation(operation); }
  catch (error) { throw new WalletActionError(isOwnerRejection(error) ? "OWNER_REJECTED" : "SIGNING_FAILED", isOwnerRejection(error) ? "You declined the wallet signature. Nothing was submitted." : "The wallet signature failed. Nothing was submitted."); }
  await assertReady();
  const candidateHash = getUserOperationHash({ userOperation: { ...operation, signature }, entryPointAddress: entryPoint.address, entryPointVersion: entryPoint.version, chainId: sepolia.id });
  const payload = formatUserOperationRequest({ ...operation, signature });
  return broadcastPreparedOperation({ candidateHash, assertBeforeSend: async () => { await assertReady(); await checkGas(); }, send: () => owner.client.request({ method: "eth_sendUserOperation", params: [payload, entryPoint.address] }, { retryCount: 0 }), onSubmitted, wait: hash => owner.client.waitForUserOperationReceipt({ hash, timeout: 120_000 }) });
}

export async function approveHyperliquidAgent(agentAddress: string, agentName = "Orcus") {
  const wallet = await ownerWallet(arbitrumSepolia);
  const client = new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet: await hyperliquidOwnerSigner(wallet.account.address), signatureChainId: "0x66eee" });
  return client.approveAgent({ agentAddress: getAddress(agentAddress), agentName: agentName.slice(0, 16) });
}

async function ostiumOwnerContext(account: TradingAccount) {
  const wallet = await ownerWallet(arbitrumSepolia, account.ownerAddress), publicClient = createPublicClient({ chain: arbitrumSepolia, transport: custom(provider(), { retryCount: 0 }) });
  const ready = async () => { await accountControl(account); await assertOwner(account.ownerAddress, arbitrumSepolia); await assertOstiumOwnerDeployment(publicClient); };
  await ready();
  return { wallet, publicClient, ready };
}

async function ostiumPreflight<T>(check: () => Promise<T>): Promise<T> {
  try { return await check(); }
  catch (error) {
    if (error instanceof WalletActionError) throw error;
    throw new WalletActionError(isOwnerRejection(error) ? "OWNER_REJECTED" : "PREFLIGHT_FAILED", isOwnerRejection(error) ? "You cancelled the wallet request. Nothing was submitted." : "Wallet checks could not finish. Nothing was submitted; check your connection and try again.");
  }
}

async function estimateOstiumOwnerGas(context: Awaited<ReturnType<typeof ostiumOwnerContext>>, transaction: EvmTransaction) {
  let estimate: bigint;
  try { estimate = await context.publicClient.estimateGas({ account: context.wallet.account.address, to: getAddress(transaction.to), data: transaction.data as Hex, value: 0n }); }
  catch { throw new WalletActionError("GAS_ESTIMATION_FAILED", "Gas estimation failed before submission. Check your Arbitrum Sepolia connection and balance, then try again."); }
  if (estimate <= 0n) throw new WalletActionError("GAS_ESTIMATION_FAILED", "The network returned an invalid gas estimate. Nothing was submitted; try again.");
  return (estimate * 120n + 99n) / 100n;
}

async function changeOstiumDelegation(account: TradingAccount, plan: OstiumDelegationPlan, purpose: "grant" | "revoke") {
  const context = await ostiumPreflight(async () => {
    inspectOstiumOwnerPlan(account, plan, purpose);
    const context = await ostiumOwnerContext(account);
    const current = await context.publicClient.readContract({ address: OSTIUM_TESTNET.trading, abi: ostiumTradingAbi, functionName: "delegations", args: [getAddress(account.ownerAddress)] });
    if (getAddress(current) !== getAddress(plan.currentDelegate)) throw new WalletActionError("CONTROL_CHANGED", "The native delegate changed after review. Refresh before signing.");
    if (plan.alreadyActive && getAddress(current) !== getAddress(plan.delegate)) throw new WalletActionError("CONTROL_CHANGED", "The reviewed delegation is not active.");
    const gas = plan.alreadyActive ? undefined : await estimateOstiumOwnerGas(context, plan.transactions[0]!);
    inspectOstiumOwnerPlan(account, plan, purpose); await context.ready();
    return { ...context, gas };
  });
  if (plan.alreadyActive) return { alreadyActive: true as const };
  const transaction = plan.transactions[0]!;
  let hash: Hex;
  try { hash = await context.wallet.sendTransaction({ to: getAddress(transaction.to), data: transaction.data as Hex, value: 0n, gas: context.gas }); }
  catch (error) { throw new WalletActionError(isOwnerRejection(error) ? "OWNER_REJECTED" : "SUBMISSION_UNKNOWN", isOwnerRejection(error) ? "You declined the native permission change. Nothing was submitted." : "The permission transaction has an unknown result. Read native authority before requesting another signature.", isOwnerRejection(error) ? "not-submitted" : "submitted-unknown"); }
  let receipt;
  try { receipt = await context.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }); }
  catch { throw new WalletActionError("RECEIPT_UNKNOWN", "The permission transaction was sent. Check its receipt and native authority before retrying.", "submitted-unknown", { transactionHash: hash }); }
  if (receipt.status !== "success") throw new WalletActionError("PERMISSION_REVERTED", "The native permission transaction reverted.", "reverted", { transactionHash: hash });
  let delegate: Address;
  try { delegate = await context.publicClient.readContract({ address: OSTIUM_TESTNET.trading, abi: ostiumTradingAbi, functionName: "delegations", args: [getAddress(account.ownerAddress)] }); }
  catch { throw new WalletActionError("PERMISSION_NOT_PROVEN", "The transaction confirmed, but agent access could not be checked. Check this transaction again.", "submitted-unknown", { transactionHash: hash }); }
  if (getAddress(delegate) !== getAddress(plan.delegate)) throw new WalletActionError("PERMISSION_NOT_PROVEN", "The transaction confirmed, but the requested native authority is not active. Keep automation disabled.", "submitted-unknown", { transactionHash: hash });
  return { transactionHash: hash, delegate, alreadyActive: false as const };
}

export async function grantOstiumPermission(input: { account: TradingAccount; plan: OstiumDelegationPlan; acknowledgement: unknown }) {
  const acknowledgement = ostiumDelegationAcknowledgementSchema.parse(input.acknowledgement);
  if (getAddress(acknowledgement.trader) !== getAddress(input.account.ownerAddress) || !input.account.agentAddress || getAddress(acknowledgement.agentAddress) !== getAddress(input.account.agentAddress)) throw new WalletActionError("ACKNOWLEDGEMENT_REQUIRED", "Review the broad native authority for this exact owner and agent before granting access.");
  return changeOstiumDelegation(input.account, input.plan, "grant");
}

export async function revokeOstiumPermission(input: { account: TradingAccount; plan: OstiumDelegationPlan }) {
  return changeOstiumDelegation(input.account, input.plan, "revoke");
}

export async function approveOstiumAllowance(input: { account: TradingAccount; intent: OstiumAllowancePlan }) {
  const context = await ostiumPreflight(async () => {
    inspectOstiumOwnerPlan(input.account, input.intent, "allowance");
    return ostiumOwnerContext(input.account);
  }), intentId = input.intent.id;
  const post = async (path: string, evidence: Record<string, unknown>) => {
    const response = await fetch(`/api/ostium/allowances/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intentId, ...evidence }) });
    if (!response.ok) throw new Error("The owner allowance state could not be recorded. Check the existing request before retrying.");
    return response.json();
  };
  const gas = await ostiumPreflight(async () => {
    const gas = await estimateOstiumOwnerGas(context, input.intent.transaction);
    await context.ready(); inspectOstiumOwnerPlan(input.account, input.intent, "allowance");
    return gas;
  });
  const submissionToken = crypto.randomUUID();
  await ostiumPreflight(() => post("submit", { submissionToken }));
  try {
    await ostiumPreflight(async () => { inspectOstiumOwnerPlan(input.account, input.intent, "allowance"); await context.ready(); });
  } catch (error) {
    try { await post("cancel", { preflightFailed: true, submissionToken }); } catch {}
    if (error instanceof WalletActionError) throw error;
    throw new WalletActionError("PREFLIGHT_FAILED", "The approval could not be started. Nothing was submitted; refresh its status before trying again.");
  }
  let hash: Hex;
  try {
    hash = await context.wallet.sendTransaction({ to: OSTIUM_TESTNET.usdc, data: input.intent.transaction.data as Hex, value: 0n, gas });
  } catch (error) {
    if (isOwnerRejection(error)) { try { await post("cancel", { ownerRejected: true, submissionToken }); } catch {} throw new WalletActionError("OWNER_REJECTED", "You declined the exact USDC allowance. No approval was submitted."); }
    throw new WalletActionError("SUBMISSION_UNKNOWN", "The allowance wallet response is unknown. Recover the transaction hash in the existing request; do not open another signature.", "submitted-unknown");
  }
  try { await post("submit", { transactionHash: hash }); }
  catch { throw new WalletActionError("SUBMISSION_RECORDING_FAILED", "The allowance was sent, but its hash could not be saved. Recover this hash before any new signature.", "submitted-unknown", { transactionHash: hash }); }
  let receipt;
  try { receipt = await context.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }); }
  catch { throw new WalletActionError("RECEIPT_UNKNOWN", "The allowance was sent. Reconcile its existing request after the receipt is available.", "submitted-unknown", { transactionHash: hash }); }
  const result = await post("reconcile", { transactionHash: hash });
  if (receipt.status !== "success") throw new WalletActionError("APPROVAL_REVERTED", "The exact USDC approval reverted.", "reverted", { transactionHash: hash });
  return { transactionHash: hash, result };
}

async function hyperliquidOwnerSigner(owner: string) {
  await assertOwner(owner, arbitrumSepolia);
  // Hyperliquid's approval type contains a colon rejected by viem's struct validator.
  const signer = await new BrowserProvider(provider()).getSigner(owner);
  return {
    getAddress: () => signer.getAddress(),
    signTypedData: async (domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>) => {
      await assertOwner(owner, arbitrumSepolia);
      const signature = await signer.signTypedData(domain, types, value);
      await assertOwner(owner, arbitrumSepolia);
      return signature;
    },
  };
}

export async function executePreparedAction(prepared: PreparedAction): Promise<{ transactionHash?: string; userOperationHash?: string; orderId?: string; response?: unknown }> {
  if (prepared.expiresAt <= Date.now()) throw new WalletActionError("QUOTE_EXPIRED", "This quote expired. Refresh it before signing.");
  const owner = await currentWalletAddress();
  if (getAddress(prepared.account.ownerAddress) !== owner) throw new Error("Your wallet changed. Reconnect the account owner before trading.");
  await accountControl(prepared.account, prepared.controlRevision);
  if (prepared.account.venue === "ostium") {
    inspectPreparedOstiumAction(prepared);
    const wallet = await ownerWallet(arbitrumSepolia, owner);
    const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: custom(provider(), { retryCount: 0 }) });
    return executeOstiumOwnerAction(prepared, {
      assertReady: async () => { await accountControl(prepared.account, prepared.controlRevision); await assertOwner(owner, arbitrumSepolia); await assertOstiumOwnerDeployment(publicClient); },
      send: transaction => wallet.sendTransaction({ to: getAddress(transaction.to), data: transaction.data as Hex, value: 0n }),
      wait: hash => publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }),
      record: evidence => recordSubmission(prepared.id, evidence),
    });
  }
  if (prepared.account.venue === "hyperliquid") {
    if (!prepared.hyperliquid || prepared.kind !== "hyperliquid") throw new Error("The venue request is missing.");
    if (prepared.account.chainId !== arbitrumSepolia.id || getAddress(prepared.account.address) !== owner || prepared.request.accountId !== prepared.account.id) throw new WalletActionError("ACCOUNT_CHANGED", "The Hyperliquid testnet account does not match this owner.");
    const wallet = await ownerWallet(arbitrumSepolia, owner);
    const exchange = new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet: await hyperliquidOwnerSigner(wallet.account.address), signatureChainId: "0x66eee", defaultExpiresAfter: prepared.expiresAt });
    const operation = prepared.hyperliquid;
    if (operation.params.vaultAddress && getAddress(String(operation.params.vaultAddress)) !== owner) throw new WalletActionError("ACCOUNT_CHANGED", "Trading through a different Hyperliquid vault is not authorized.");
    await accountControl(prepared.account, prepared.controlRevision);
    await assertOwner(owner, arbitrumSepolia);
    let response: unknown;
    try {
    if (operation.method === "order") response = await exchange.order(operation.params as Parameters<typeof exchange.order>[0]);
    else if (operation.method === "cancel") response = await exchange.cancel(operation.params as Parameters<typeof exchange.cancel>[0]);
    else if (operation.method === "cancelByCloid") response = await exchange.cancelByCloid(operation.params as Parameters<typeof exchange.cancelByCloid>[0]);
    else if (operation.method === "updateLeverage") response = await exchange.updateLeverage(operation.params as Parameters<typeof exchange.updateLeverage>[0]);
    else throw new Error("Unsupported venue operation.");
    } catch (error) {
      if (isOwnerRejection(error)) throw new WalletActionError("OWNER_REJECTED", "You declined the wallet signature. Nothing was submitted.");
      try { await recordSubmission(prepared.id, { result: { venue: "hyperliquid", submissionUnknown: true } }); } catch {}
      throw new WalletActionError("SUBMISSION_UNKNOWN", "The venue response is unknown. Check orders and activity before retrying.", "submitted-unknown");
    }
    const statuses = (response as { response?: { data?: { statuses?: Array<{ resting?: { oid: number }; filled?: { oid: number }; error?: string }> } } }).response?.data?.statuses;
    const error = statuses?.find(status => status.error)?.error;
    if (error) throw new WalletActionError("VENUE_REJECTED", error);
    const orderId = statuses?.map(status => status.resting?.oid ?? status.filled?.oid).find(id => id !== undefined);
    return { orderId: orderId === undefined ? undefined : String(orderId), response };
  }
  inspectPreparedSwap(prepared);
  const kernel = await ownerKernel(await browserKernelConfig({ actionId: prepared.id }), owner);
  if (getAddress(kernel.account.address) !== getAddress(prepared.account.address)) throw new Error("The prepared trading account does not belong to this wallet.");
  const calls = prepared.transactions!.map(tx => ({ to: getAddress(tx.to), data: tx.data as Hex, value: BigInt(tx.value) }));
  const result = await sendOwnerOperation(kernel, calls, async () => { inspectPreparedSwap(prepared); await accountControl(prepared.account, prepared.controlRevision); await assertOwner(owner, sepolia); }, evidence => recordSubmission(prepared.id, evidence));
  if (result.status === "rejected") throw new WalletActionError("SWAP_REVERTED", "The swap reverted onchain. Check activity before retrying.", "reverted", result);
  return { ...result, response: { userOperationHash: result.userOperationHash } };
}

export async function grantKernelPermission(input: KernelGrantPolicy): Promise<KernelAuthorization> {
  const policy = kernelGrantPolicySchema.parse(input);
  if (policy.expiresAt <= Date.now() || policy.issuedAt > Date.now() + 10_000) throw new Error("Permission validity is incorrect.");
  const config = await browserKernelConfig({ accountAddress: policy.accountAddress, purpose: "permission-management" });
  const ownerAddress = await currentWalletAddress();
  const owner = await ownerKernel(config, ownerAddress);
  if (getAddress(owner.account.address) !== getAddress(policy.accountAddress)) throw new Error("This permission targets a different trading account.");
  const regular = await createPermissionPlugin(config, policy);
  const account = await createKernelAccount(owner.publicClient, { entryPoint, kernelVersion, plugins: { sudo: owner.sudo, regular } });
  await assertOwner(ownerAddress, sepolia);
  const approval = await serializePermissionAccount(account);
  await assertOwner(ownerAddress, sepolia);
  return { approval, policy };
}

async function permissionOwner(input: KernelGrantPolicy) {
  const policy = kernelGrantPolicySchema.parse(input);
  const config = await browserKernelConfig({ accountAddress: policy.accountAddress, purpose: "permission-management" });
  const ownerAddress = await currentWalletAddress();
  const owner = await ownerKernel(config, ownerAddress);
  if (getAddress(owner.account.address) !== getAddress(policy.accountAddress)) throw new Error("This permission targets a different account.");
  const plugin = await createPermissionPlugin(config, policy);
  return { policy, owner, ownerAddress, plugin };
}

export async function revokeKernelPermission(input: KernelGrantPolicy) {
  const { owner, ownerAddress, plugin } = await permissionOwner(input);
  const id = plugin.getIdentifier() as Hex;
  const deployed = await owner.publicClient.getCode({ address: owner.account.address });
  if (!deployed || deployed === "0x") throw new WalletActionError("PENDING_APPROVAL_INVALIDATION_REQUIRED", "This signed grant is not installed yet. Invalidate older approvals explicitly or wait for expiry; app disable alone does not revoke it.");
  const before = await owner.publicClient.readContract({ address: owner.account.address, abi: KernelV3_1AccountAbi, functionName: "permissionConfig", args: [id] });
  if (before.signer === zeroAddress) throw new WalletActionError("PENDING_APPROVAL_INVALIDATION_REQUIRED", "No installed signer was found. A pending signed grant may remain valid. Explicitly invalidate older approvals or wait for expiry.");
  const validationId = concatHex(["0x02", padHex(id, { size: 20, dir: "right" })]);
  const data = encodeFunctionData({ abi: KernelV3_1AccountAbi, functionName: "uninstallValidation", args: [validationId, await plugin.getEnableData(owner.account.address), "0x"] });
  const result = await sendOwnerOperation(owner, [{ to: owner.account.address, data, value: 0n }], () => assertOwner(ownerAddress, sepolia));
  if (result.status !== "confirmed") throw new WalletActionError("REVOCATION_REVERTED", "Native revocation reverted. The agent authority may still be active.", "reverted", result);
  let after;
  try { after = await owner.publicClient.readContract({ address: owner.account.address, abi: KernelV3_1AccountAbi, functionName: "permissionConfig", args: [id] }); }
  catch { throw new WalletActionError("REVOCATION_PROOF_UNAVAILABLE", "The revocation transaction confirmed, but its onchain state could not be verified. Do not assume authority was removed.", "submitted-unknown", result); }
  if (after.signer !== zeroAddress) throw new WalletActionError("REVOCATION_NOT_PROVEN", "The permission signer is still installed. Keep the agent disabled and inspect the transaction.", "submitted-unknown", result);
  return result.transactionHash;
}

export async function invalidateKernelPendingApprovals(input: KernelGrantPolicy, confirmation: { invalidateAllOlderSessions: true }) {
  if (confirmation?.invalidateAllOlderSessions !== true) throw new WalletActionError("CONFIRMATION_REQUIRED", "Explicit confirmation is required because nonce invalidation disables all older session approvals for this account.");
  const { owner, ownerAddress } = await permissionOwner(input);
  const deployed = await owner.publicClient.getCode({ address: owner.account.address });
  const currentNonce = deployed && deployed !== "0x" ? await owner.publicClient.readContract({ address: owner.account.address, abi: KernelV3_1AccountAbi, functionName: "currentNonce" }) : 1;
  if (currentNonce >= 0xffffffff) throw new WalletActionError("NONCE_LIMIT", "The account validation nonce cannot be incremented safely.");
  const nonceFloor = currentNonce + 1;
  const data = encodeFunctionData({ abi: KernelV3_1AccountAbi, functionName: "invalidateNonce", args: [nonceFloor] });
  const result = await sendOwnerOperation(owner, [{ to: owner.account.address, data, value: 0n }], () => assertOwner(ownerAddress, sepolia));
  if (result.status !== "confirmed") throw new WalletActionError("REVOCATION_REVERTED", "Nonce invalidation reverted. The signed approvals may still be valid.", "reverted", result);
  let actualFloor;
  try { actualFloor = await owner.publicClient.readContract({ address: owner.account.address, abi: KernelV3_1AccountAbi, functionName: "validNonceFrom" }); }
  catch { throw new WalletActionError("REVOCATION_PROOF_UNAVAILABLE", "The nonce invalidation confirmed, but its state could not be read. Check the account before assuming grants are revoked.", "submitted-unknown", result); }
  if (actualFloor < nonceFloor) throw new WalletActionError("REVOCATION_NOT_PROVEN", "The account nonce floor does not prove older approvals were invalidated.", "submitted-unknown", result);
  return { ...result, nonceFloor: actualFloor, invalidatedAllOlderSessions: true };
}

export async function fundTradingAccount(input: { account: TradingAccount; asset: "ETH" | "USDC" | "WETH"; amount: string }) {
  if (!["ETH", "USDC", "WETH"].includes(input.asset)) throw new WalletActionError("TOKEN_UNCONFIGURED", "Choose a configured Sepolia funding asset.");
  if (input.account.venue !== "uniswap" || input.account.chainId !== sepolia.id) throw new WalletActionError("UNSUPPORTED_NETWORK", "This funding flow supports only your Sepolia Kernel trading account. Fund Hyperliquid through its native testnet deposit flow.");
  await accountControl(input.account);
  const config = await browserKernelConfig();
  const ownerAddress = getAddress(input.account.ownerAddress);
  const kernel = await ownerKernel(config, ownerAddress);
  if (getAddress(kernel.account.address) !== getAddress(input.account.address)) throw new WalletActionError("ACCOUNT_CHANGED", "The funding destination is not your derived trading account.");
  const wallet = await ownerWallet(sepolia, ownerAddress);
  const recipient = kernel.account.address;
  let hash: Hex;
  const ready = async () => { await accountControl(input.account); await assertOwner(ownerAddress, sepolia); };
  if (input.asset === "ETH") {
    const value = exactTokenAmount(input.amount, 18);
    const gas = await kernel.publicClient.estimateGas({ account: wallet.account, to: recipient, value });
    const fees = await kernel.publicClient.estimateFeesPerGas();
    const gasLimit = gas * 120n / 100n;
    const balance = await kernel.publicClient.getBalance({ address: ownerAddress });
    if (balance < value + gasLimit * fees.maxFeePerGas) throw new WalletActionError("INSUFFICIENT_FUNDS", "Keep enough Sepolia ETH in your owner wallet for the funding amount and gas.");
    await ready();
    try { hash = await wallet.sendTransaction({ to: recipient, value, gas: gasLimit, ...fees }); }
    catch (error) { throw fundingSendError(error); }
  } else {
    const response = await fetch("/api/wallet-config", { cache: "no-store" });
    const result = await response.json();
    const configured = result.data?.[input.asset === "USDC" ? "usdc" : "weth"];
    if (!response.ok || !configured || result.data.chainId !== sepolia.id) throw new WalletActionError("TOKEN_UNCONFIGURED", "The configured Sepolia funding token is unavailable.");
    const token = getAddress(configured);
    const decimals = await kernel.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    const amount = exactTokenAmount(input.amount, decimals);
    const envelope = await prepareOwnerTokenTransfer(kernel.publicClient, { owner: ownerAddress, token, recipient, amount });
    await ready();
    try { hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [recipient, amount], gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas, maxPriorityFeePerGas: envelope.maxPriorityFeePerGas }); }
    catch (error) { throw fundingSendError(error); }
  }
  let receipt;
  try { receipt = await kernel.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }); }
  catch { throw new WalletActionError("RECEIPT_UNKNOWN", "Your funding transfer was sent. Check its transaction before retrying.", "submitted-unknown", { transactionHash: hash }); }
  if (receipt.status !== "success") throw new WalletActionError("FUNDING_REVERTED", "The funding transfer reverted onchain.", "reverted", { transactionHash: hash });
  return { transactionHash: receipt.transactionHash, recipient, chainId: sepolia.id, asset: input.asset, amount: input.amount };
}

export async function fundOperatingWallet(input: { ownerAddress: string; operatingAddress: string; amount: string }) {
  const ownerAddress = getAddress(input.ownerAddress), recipient = getAddress(input.operatingAddress);
  const assertSession = async () => {
    await assertOwner(ownerAddress);
    const response = await fetch("/api/session", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.data?.user?.address || !result.data?.agent?.operatingAddress || getAddress(result.data.user.address) !== ownerAddress || getAddress(result.data.agent.operatingAddress) !== recipient || recipient === ownerAddress) throw new WalletActionError("ACCOUNT_CHANGED", "The owner or operating wallet changed. Refresh before funding.");
  };
  await assertSession();
  const value = exactTokenAmount(input.amount, 18);
  const wallet = await ownerWallet(galileo, ownerAddress);
  const client = createPublicClient({ chain: galileo, transport: http(undefined, { timeout: 10_000, retryCount: 1 }) });
  if (await client.getChainId() !== galileo.id) throw new WalletActionError("WRONG_NETWORK", "The operating-wallet RPC is not 0G Galileo testnet.");
  const gas = await client.estimateGas({ account: wallet.account, to: recipient, value });
  const fees = await client.estimateFeesPerGas();
  const gasLimit = gas * 120n / 100n;
  if (await client.getBalance({ address: ownerAddress }) < value + gasLimit * fees.maxFeePerGas) throw new WalletActionError("INSUFFICIENT_FUNDS", "Keep enough testnet 0G in your owner wallet for the funding amount and gas.");
  await assertSession();
  await assertOwner(ownerAddress, galileo);
  let hash: Hex;
  try { hash = await wallet.sendTransaction({ to: recipient, value, gas: gasLimit, ...fees }); }
  catch (error) { throw fundingSendError(error); }
  let receipt;
  try { receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 }); }
  catch { throw new WalletActionError("RECEIPT_UNKNOWN", "Operating-wallet funding was sent. Inspect its transaction before retrying.", "submitted-unknown", { transactionHash: hash }); }
  if (receipt.status !== "success") throw new WalletActionError("FUNDING_REVERTED", "Operating-wallet funding reverted onchain.", "reverted", { transactionHash: hash });
  return { transactionHash: receipt.transactionHash, recipient, chainId: galileo.id, asset: "0G" as const, amount: input.amount, purpose: "operating-wallet-funding" as const, computeCredits: false };
}

function fundingSendError(error: unknown) {
  return isOwnerRejection(error) ? new WalletActionError("OWNER_REJECTED", "You declined the funding transaction. Nothing was submitted.") : new WalletActionError("SUBMISSION_UNKNOWN", "The funding wallet did not confirm its submission result. Check wallet activity before retrying.", "submitted-unknown");
}
