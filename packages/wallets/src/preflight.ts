import type { PreparedAction } from "@orcus/core";
import { decodeFunctionData, encodeFunctionData, getAddress, isHex, parseAbi, parseUnits, type Hex } from "viem";
import { kernelGrantPolicySchema, type KernelGrantPolicy } from "./kernel";

export interface WalletEvidence {
  transactionHash?: string;
  userOperationHash?: string;
  orderId?: string;
}

export class WalletActionError extends Error {
  readonly status: number;
  constructor(public code: string, message: string, public phase: "not-submitted" | "submitted-unknown" | "reverted" = "not-submitted", public evidence?: WalletEvidence) {
    super(message);
    this.name = "WalletActionError";
    this.status = phase === "submitted-unknown" ? 504 : 422;
  }
}

export function exactTokenAmount(value: string, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) throw new WalletActionError("INVALID_TOKEN_AMOUNT", "Enter a positive amount within the token's decimal precision.");
  const amount = parseUnits(value, decimals);
  if (amount <= 0n) throw new WalletActionError("INVALID_TOKEN_AMOUNT", "The token amount must be positive.");
  return amount;
}

export function isOwnerRejection(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const item = current as { code?: unknown; name?: string; message?: string; cause?: unknown };
    if (item.code === 4001 || item.name === "UserRejectedRequestError" || /user rejected|user denied/i.test(item.message ?? "")) return true;
    current = item.cause;
  }
  return false;
}

export const swapCallAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns (uint256)",
  "function multicall(uint256 deadline,bytes[] data) returns (bytes[])",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

function invalid(message: string): never {
  throw new WalletActionError("INVALID_PREPARED_SWAP", message);
}

export function inspectPreparedSwap(prepared: PreparedAction, now = Date.now()) {
  if (prepared.account.venue !== "uniswap" || prepared.request.venue !== "uniswap" || prepared.request.type !== "swap" || prepared.account.chainId !== 11155111 || prepared.request.accountId !== prepared.account.id) invalid("The prepared swap does not match this Sepolia trading account.");
  if (prepared.expiresAt <= now || prepared.controlRevision !== prepared.account.controlRevision) invalid("The quote expired or the account revision changed. Prepare the swap again.");
  const transactions = prepared.transactions;
  if (!transactions?.length || transactions.length > 3) invalid("A swap can contain at most two exact approvals and one router call.");
  for (const transaction of transactions) {
    if (transaction.chainId !== 11155111 || !isHex(transaction.data) || transaction.value !== "0") invalid("Only zero-value Sepolia swap calls are supported.");
  }
  const routerCall = transactions[transactions.length - 1];
  let outer: ReturnType<typeof decodeFunctionData<typeof swapCallAbi>>;
  try { outer = decodeFunctionData({ abi: swapCallAbi, data: routerCall.data as Hex }); }
  catch { invalid("The router call cannot be decoded safely."); }
  if (outer.functionName !== "multicall") invalid("Swaps require a deadline-protected router call.");
  const [deadline, nested] = outer.args;
  if (nested.length !== 1 || deadline * 1000n <= BigInt(now) || deadline * 1000n > BigInt(prepared.expiresAt)) invalid("The swap must have one inner action and an unexpired quoted deadline.");
  const canonicalOuter = encodeFunctionData({ abi: swapCallAbi, functionName: "multicall", args: [deadline, nested] });
  if (canonicalOuter.toLowerCase() !== routerCall.data.toLowerCase()) invalid("Noncanonical or additional router call data is not permitted.");
  let inner: ReturnType<typeof decodeFunctionData<typeof swapCallAbi>>;
  try { inner = decodeFunctionData({ abi: swapCallAbi, data: nested[0] }); }
  catch { invalid("The inner swap call cannot be decoded safely."); }
  if (inner.functionName !== "exactInputSingle") invalid("Only a single exact-input swap is supported.");
  const swap = inner.args[0];
  if (swap.amountIn <= 0n || swap.amountOutMinimum <= 0n || swap.sqrtPriceLimitX96 !== 0n || getAddress(swap.recipient) !== getAddress(prepared.account.address)) invalid("The swap amount, minimum output or recipient is unsafe.");
  if (encodeFunctionData({ abi: swapCallAbi, functionName: "exactInputSingle", args: [swap] }).toLowerCase() !== nested[0].toLowerCase()) invalid("Noncanonical inner swap data is not permitted.");
  const request = prepared.request;
  if (!request.tokenIn || !request.tokenOut || request.tokenInDecimals === undefined || request.tokenOutDecimals === undefined || !prepared.quote?.minimumOut) invalid("Refresh the quote to verify the token addresses, precision and minimum output.");
  if (getAddress(request.tokenIn) !== getAddress(swap.tokenIn) || getAddress(request.tokenOut) !== getAddress(swap.tokenOut) || request.feeTier !== swap.fee) invalid("The quoted pair or fee differs from the executable swap.");
  if (exactTokenAmount(request.amount, request.tokenInDecimals) !== swap.amountIn || exactTokenAmount(prepared.quote.minimumOut, request.tokenOutDecimals) !== swap.amountOutMinimum) invalid("The executable amounts differ from the reviewed quote.");
  for (const approval of transactions.slice(0, -1)) {
    let call: ReturnType<typeof decodeFunctionData<typeof swapCallAbi>>;
    try { call = decodeFunctionData({ abi: swapCallAbi, data: approval.data as Hex }); }
    catch { invalid("The token approval cannot be decoded safely."); }
    if (call.functionName !== "approve" || getAddress(approval.to) !== getAddress(swap.tokenIn) || getAddress(call.args[0]) !== getAddress(routerCall.to) || ![0n, swap.amountIn].includes(call.args[1])) invalid("Approvals must target this router for exactly the input amount or reset to zero.");
    if (encodeFunctionData({ abi: swapCallAbi, functionName: "approve", args: call.args }).toLowerCase() !== approval.data.toLowerCase()) invalid("Additional approval data is not permitted.");
  }
  return { router: getAddress(routerCall.to), deadline, ...swap };
}

export function assertKernelPolicyCompatible(prepared: PreparedAction, input: KernelGrantPolicy, now = Date.now()) {
  const policy = kernelGrantPolicySchema.parse(input);
  if (policy.expiresAt <= now || policy.issuedAt > now + 10_000 || getAddress(policy.accountAddress) !== getAddress(prepared.account.address) || prepared.account.agentAddress && getAddress(policy.agentAddress) !== getAddress(prepared.account.agentAddress)) throw new WalletActionError("SESSION_AUTHORITY_MISMATCH", "The active session does not match this account or has expired.");
  const swap = inspectPreparedSwap(prepared, now);
  if (swap.router !== getAddress(policy.router) || swap.deadline > BigInt(Math.floor(policy.expiresAt / 1000))) throw new WalletActionError("SESSION_AUTHORITY_MISMATCH", "The router or deadline is outside the owner-approved session.");
  const compatible = policy.swaps.find(rule => getAddress(rule.tokenIn) === getAddress(swap.tokenIn) && getAddress(rule.tokenOut) === getAddress(swap.tokenOut) && rule.feeTier === swap.fee && swap.amountIn <= BigInt(rule.maxAmountIn) && swap.amountOutMinimum >= BigInt(rule.minAmountOut));
  if (!compatible) throw new WalletActionError("KERNEL_POLICY_REGRANT_REQUIRED", "This swap is outside the owner-approved input/output size band. Review and regrant a policy for this order size; no signature or transaction was submitted.");
  return swap;
}
