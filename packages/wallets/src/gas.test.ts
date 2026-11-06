import { describe, expect, it, vi } from "vitest";
import type { GetPaymasterDataParameters } from "viem/account-abstraction";
import { assertSponsoredOperation, requiredKernelPaymaster } from "./gas";

const operation = () => ({ paymaster: `0x${"1".repeat(40)}`, paymasterData: "0x1234", callGasLimit: 10n, verificationGasLimit: 20n, preVerificationGas: 30n, paymasterVerificationGasLimit: 40n, paymasterPostOpGasLimit: 50n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
describe("required Kernel gas sponsorship", () => {
  it("includes paymaster verification and post-op gas in the exact cost ceiling", () => {
    expect(assertSponsoredOperation(operation(), "300")).toBe(300n);
    expect(() => assertSponsoredOperation(operation(), "299")).toThrow(/above the operation cap/);
    expect(() => assertSponsoredOperation({ ...operation(), paymasterPostOpGasLimit: 1000n }, "300")).toThrow();
  });
  it("rejects missing paymasters, zero addresses, absent data and invalid gas quantities", () => {
    for (const patch of [{ paymaster: undefined }, { paymaster: `0x${"0".repeat(40)}` }, { paymasterData: "0x" }, { maxFeePerGas: -1n }, { callGasLimit: 2n ** 128n }, { maxPriorityFeePerGas: 3n }, { paymasterVerificationGasLimit: undefined }]) expect(() => assertSponsoredOperation({ ...operation(), ...patch }, "10000")).toThrow();
  });
  it("never replaces an unavailable or denied sponsor with owner-paid gas", async () => {
    const input = operation() as unknown as GetPaymasterDataParameters;
    await expect(requiredKernelPaymaster().getPaymasterData(input)).rejects.toMatchObject({ code: "SPONSORSHIP_UNCONFIGURED", phase: "not-submitted" });
    const rejected = requiredKernelPaymaster({ maxOperationGasWei: "300", getPaymasterData: vi.fn().mockRejectedValue(new Error("secret provider URL")) });
    await expect(rejected.getPaymasterData(input)).rejects.toMatchObject({ code: "SPONSORSHIP_UNAVAILABLE" });
    const invalid = requiredKernelPaymaster({ maxOperationGasWei: "300", getPaymasterData: vi.fn().mockResolvedValue({}) });
    await expect(invalid.getPaymasterData({ ...input, paymaster: undefined, paymasterData: undefined } as unknown as GetPaymasterDataParameters)).rejects.toMatchObject({ code: "SPONSORSHIP_REJECTED" });
  });
  it("runs the same bounded sponsor for estimation and final approval", async () => {
    const getPaymasterData = vi.fn().mockResolvedValue(operation()), input = operation() as unknown as GetPaymasterDataParameters;
    const sponsor = requiredKernelPaymaster({ maxOperationGasWei: "300", getPaymasterData });
    await sponsor.getPaymasterStubData(input); await sponsor.getPaymasterData(input);
    expect(getPaymasterData).toHaveBeenCalledTimes(2);
  });
  it("allows non-consuming estimation to be separate from final sponsorship", async () => {
    const final = vi.fn().mockResolvedValue(operation()), stub = vi.fn().mockResolvedValue(operation()), input = operation() as unknown as GetPaymasterDataParameters;
    const sponsor = requiredKernelPaymaster({ maxOperationGasWei: "300", getPaymasterData: final, getPaymasterStubData: stub });
    await sponsor.getPaymasterStubData(input); expect(stub).toHaveBeenCalledOnce(); expect(final).not.toHaveBeenCalled();
    await sponsor.getPaymasterData(input); expect(final).toHaveBeenCalledOnce();
  });
});
