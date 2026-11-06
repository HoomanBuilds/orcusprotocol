import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, http, zeroAddress, type EIP1193Provider, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { isOwnerRejection, WalletActionError } from "./preflight";
import { prepareOwnerTokenTransfer } from "./token-transfer";

export type ServicePaymentQuote = { id: string; mode: "testnet"; testOnly: true; chainId: 11155111; token: string; payer: string; treasury: string; amountBaseUnits: string; data: Hex; value: "0"; status: string; expiresAt: number };

export function assertServicePaymentQuote(quote: ServicePaymentQuote, owner: string) {
  if (quote.mode !== "testnet" || !quote.testOnly || quote.chainId !== sepolia.id || quote.value !== "0" || quote.status !== "prepared" || quote.expiresAt <= Date.now() || getAddress(quote.payer) !== getAddress(owner) || getAddress(quote.token) !== getAddress("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238") || !/^\d{1,9}$/.test(quote.amountBaseUnits) || BigInt(quote.amountBaseUnits) < 10_000n || BigInt(quote.amountBaseUnits) > 100_000_000n) throw new WalletActionError("SERVICE_PAYMENT_EXPIRED", "Review a fresh Sepolia test-USDC quote for this owner before paying.");
  if ([zeroAddress, getAddress(owner)].includes(getAddress(quote.treasury))) throw new WalletActionError("SERVICE_PAYMENT_EVIDENCE_INVALID", "The payment treasury must be a separate nonzero address.");
  const call = decodeFunctionData({ abi: erc20Abi, data: quote.data });
  if (call.functionName !== "transfer" || getAddress(call.args[0]) !== getAddress(quote.treasury) || call.args[1] !== BigInt(quote.amountBaseUnits) || encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(quote.treasury), BigInt(quote.amountBaseUnits)] }).toLowerCase() !== quote.data.toLowerCase()) throw new WalletActionError("SERVICE_PAYMENT_EVIDENCE_INVALID", "The payment does not match its exact reviewed treasury and USDC amount.");
}

export async function payServiceCredits(quote: ServicePaymentQuote, hooks: { beforeSubmit: () => Promise<void>; onSubmitted: (hash: Hex) => Promise<void> }, suppliedProvider?: EIP1193Provider) {
  const ethereum = suppliedProvider ?? (typeof window !== "undefined" ? (window as Window & { ethereum?: EIP1193Provider }).ethereum : undefined);
  if (!ethereum) throw new WalletActionError("OWNER_REJECTED", "Connect an owner wallet before paying for test credits.");
  const accounts = await ethereum.request({ method: "eth_accounts" }), owner = accounts[0];
  if (!owner) throw new WalletActionError("OWNER_REJECTED", "Connect an owner wallet before paying for test credits.");
  assertServicePaymentQuote(quote, owner);
  const wallet = createWalletClient({ account: getAddress(owner), chain: sepolia, transport: custom(ethereum, { retryCount: 0 }) });
  if (await wallet.getChainId() !== sepolia.id) await wallet.switchChain({ id: sepolia.id });
  const assertOwner = async () => {
    const current = await ethereum.request({ method: "eth_accounts" });
    if (!current[0] || getAddress(current[0]) !== getAddress(quote.payer) || Number(await ethereum.request({ method: "eth_chainId" })) !== sepolia.id) throw new WalletActionError("OWNER_CHANGED", "The wallet owner or network changed. Nothing was submitted.");
  };
  await assertOwner();
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const client = createPublicClient({ chain: sepolia, transport: http(new URL("/api/rpc", origin).href, { fetchOptions: { credentials: "same-origin", redirect: "error" }, retryCount: 0 }) });
  const envelope = await prepareOwnerTokenTransfer(client, { owner: getAddress(owner), token: getAddress(quote.token), recipient: getAddress(quote.treasury), amount: BigInt(quote.amountBaseUnits), maxGasCostWei: 3_000_000_000_000_000n });
  await hooks.beforeSubmit();
  await assertOwner();
  if (quote.expiresAt <= Date.now()) throw new WalletActionError("SERVICE_PAYMENT_EXPIRED", "The payment quote expired before the wallet opened.");
  let hash: Hex;
  try { hash = await wallet.sendTransaction({ account: getAddress(owner), to: getAddress(quote.token), data: quote.data, value: 0n, gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas, maxPriorityFeePerGas: envelope.maxPriorityFeePerGas }); }
  catch (error) {
    if (isOwnerRejection(error)) throw new WalletActionError("OWNER_REJECTED", "Payment cancelled in your wallet. No credits were added.");
    throw new WalletActionError("SUBMISSION_UNKNOWN", "The payment submission is uncertain. Check the same intent and your wallet history before paying again.", "submitted-unknown");
  }
  try { await hooks.onSubmitted(hash); }
  catch { throw new WalletActionError("SUBMISSION_UNKNOWN", "The payment hash could not be saved. Reconcile the same payment using its wallet transaction hash.", "submitted-unknown", { transactionHash: hash }); }
  return { transactionHash: hash };
}
