import { createZeroDevPaymasterClient } from "@zerodev/sdk";
import { getAddress, http, zeroAddress, type Hex } from "viem";
import { sepolia } from "viem/chains";
import type { PaymasterActions } from "viem/account-abstraction";
import { WalletActionError } from "./preflight";

export type KernelGasSponsorship = { getPaymasterData: PaymasterActions["getPaymasterData"]; maxOperationGasWei: string; onSignedOperation?: (operation: Record<string, unknown>, hash: Hex) => void | Promise<void>; onReceipt?: (receipt: unknown) => void | Promise<void> };
const quantities = ["callGasLimit", "verificationGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"] as const;

export function assertSponsoredOperation(value: Record<string, unknown>, capWei: string) {
  try {
    if (typeof value.paymaster !== "string" || getAddress(value.paymaster) === zeroAddress || typeof value.paymasterData !== "string" || !/^0x(?:[\da-fA-F]{2})+$/.test(value.paymasterData)) throw new Error();
    const number = (input: unknown) => { if (typeof input !== "bigint" && (typeof input !== "string" || !/^(?:0x[\da-fA-F]+|\d+)$/.test(input))) throw new Error(); const n = BigInt(input as string); if (n < 0n || n >= 2n ** 128n) throw new Error(); return n; };
    const fee = number(value.maxFeePerGas), priority = number(value.maxPriorityFeePerGas);
    const gas = quantities.reduce((sum, field) => sum + number(value[field]), 0n);
    if (fee <= 0n || priority > fee || gas <= 0n || gas * fee > BigInt(capWei)) throw new Error();
    return gas * fee;
  } catch { throw new WalletActionError("SPONSORSHIP_REJECTED", "Gas sponsorship is missing, invalid, or above the operation cap. Nothing was submitted; no owner-paid fallback was used."); }
}

export function requiredKernelPaymaster(sponsorship?: KernelGasSponsorship) {
  const sponsor: PaymasterActions["getPaymasterData"] = async input => {
    if (!sponsorship) throw new WalletActionError("SPONSORSHIP_UNCONFIGURED", "Gas sponsorship is not configured. No transaction was submitted. Owner recovery must use an explicitly reviewed direct account transaction.");
    let response;
    try { response = await sponsorship.getPaymasterData(input); }
    catch (error) { if (error instanceof WalletActionError) throw error; throw new WalletActionError("SPONSORSHIP_UNAVAILABLE", "The gas sponsor did not approve this operation. Nothing was submitted; no owner-paid fallback was used."); }
    assertSponsoredOperation({ ...input, ...response }, sponsorship.maxOperationGasWei);
    return response;
  };
  const stub: PaymasterActions["getPaymasterStubData"] = async input => await sponsor(input) as Awaited<ReturnType<PaymasterActions["getPaymasterStubData"]>>;
  return { getPaymasterData: sponsor, getPaymasterStubData: stub };
}

export function browserGasSponsorship(url: string, maxOperationGasWei: string): KernelGasSponsorship {
  const client = createZeroDevPaymasterClient({ chain: sepolia, transport: http(url, { retryCount: 0, timeout: 30_000 }) });
  return { maxOperationGasWei, getPaymasterData: input => client.sponsorUserOperation({ userOperation: input, shouldOverrideFee: false }) };
}
