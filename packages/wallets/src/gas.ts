import { createClient, getAddress, http, rpcSchema, zeroAddress, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { formatUserOperationRequest, type PaymasterActions } from "viem/account-abstraction";
import { WalletActionError } from "./preflight";

export type KernelGasSponsorship = { getPaymasterData: PaymasterActions["getPaymasterData"]; getPaymasterStubData?: PaymasterActions["getPaymasterData"]; maxOperationGasWei: string; onSignedOperation?: (operation: Record<string, unknown>, hash: Hex) => void | Promise<void>; onReceipt?: (receipt: unknown) => void | Promise<void> };
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
  const sponsor = (estimation: boolean): PaymasterActions["getPaymasterData"] => async input => {
    if (!sponsorship) throw new WalletActionError("SPONSORSHIP_UNCONFIGURED", "Gas sponsorship is not configured. No transaction was submitted. Owner-paid recovery requires a compatible account client and explicit fee approval.");
    let response;
    try { response = await (estimation ? sponsorship.getPaymasterStubData ?? sponsorship.getPaymasterData : sponsorship.getPaymasterData)(input); }
    catch (error) { if (error instanceof WalletActionError) throw error; throw new WalletActionError("SPONSORSHIP_UNAVAILABLE", "The gas sponsor did not approve this operation. Nothing was submitted; no owner-paid fallback was used."); }
    assertSponsoredOperation({ ...input, ...response }, sponsorship.maxOperationGasWei);
    return response;
  };
  const stub: PaymasterActions["getPaymasterStubData"] = async input => await sponsor(true)(input) as Awaited<ReturnType<PaymasterActions["getPaymasterStubData"]>>;
  return { getPaymasterData: sponsor(false), getPaymasterStubData: stub };
}

export function browserGasSponsorship(url: string, maxOperationGasWei: string): KernelGasSponsorship {
  const endpoint = new URL(url, window.location.origin);
  if (endpoint.origin !== window.location.origin || endpoint.username || endpoint.password) throw new WalletActionError("SPONSORSHIP_UNCONFIGURED", "Gas sponsorship requires the authenticated platform proxy. Nothing was submitted.");
  const client = createClient({ transport: http(endpoint.href, { retryCount: 0, timeout: 30_000, fetchOptions: { credentials: "same-origin", redirect: "error" } }), rpcSchema: rpcSchema<[{ Method: "orcus_sponsorUserOperation"; Parameters: [{ chainId: number; entryPointAddress: Address; userOp: ReturnType<typeof formatUserOperationRequest>; shouldOverrideFee: false; shouldConsume: boolean }]; ReturnType: Record<string, Hex> }]>() });
  const sponsor = (shouldConsume: boolean): PaymasterActions["getPaymasterData"] => async input => {
    const response = await client.request({ method: "orcus_sponsorUserOperation", params: [{ chainId: sepolia.id, entryPointAddress: input.entryPointAddress, userOp: formatUserOperationRequest(input), shouldOverrideFee: false, shouldConsume }] });
    return {
      paymaster: response.paymaster as Address, paymasterData: response.paymasterData,
      callGasLimit: BigInt(response.callGasLimit), verificationGasLimit: BigInt(response.verificationGasLimit), preVerificationGas: BigInt(response.preVerificationGas),
      paymasterVerificationGasLimit: BigInt(response.paymasterVerificationGasLimit), paymasterPostOpGasLimit: BigInt(response.paymasterPostOpGasLimit),
      maxFeePerGas: response.maxFeePerGas ? BigInt(response.maxFeePerGas) : input.maxFeePerGas,
      maxPriorityFeePerGas: response.maxPriorityFeePerGas ? BigInt(response.maxPriorityFeePerGas) : input.maxPriorityFeePerGas,
    };
  };
  return { maxOperationGasWei, getPaymasterData: sponsor(true), getPaymasterStubData: sponsor(false) };
}
