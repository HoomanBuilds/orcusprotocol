import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetPaymasterDataParameters } from "viem/account-abstraction";
import { assertSponsoredOperation, browserGasSponsorship, requiredKernelPaymaster } from "./gas";

afterEach(() => vi.unstubAllGlobals());

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

describe("provider-neutral browser sponsorship", () => {
  it("uses the authenticated local proxy for both stub and final approval", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
    const result = { ...operation(), callGasLimit: "0xa", verificationGasLimit: "0x14", preVerificationGas: "0x1e", paymasterVerificationGasLimit: "0x28", paymasterPostOpGasLimit: "0x32", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", signature: "0xdead" };
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const sponsor = requiredKernelPaymaster(browserGasSponsorship("/api/paymaster?actionId=reviewed", "300"));
    const input = { ...operation(), sender: `0x${"2".repeat(40)}`, nonce: 0n, callData: "0x1234", entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", chainId: 11155111, context: { private: "not-rpc-data" } } as GetPaymasterDataParameters;
    await sponsor.getPaymasterStubData(input);
    const approved = await sponsor.getPaymasterData(input);
    expect(approved).toMatchObject({ callGasLimit: 10n, maxFeePerGas: 2n });
    expect(approved).not.toHaveProperty("signature");
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [index, [url, options]] of fetch.mock.calls.entries()) {
      expect(url).toBe("http://localhost:3000/api/paymaster?actionId=reviewed");
      expect(options).toMatchObject({ credentials: "same-origin", redirect: "error" });
      const request = JSON.parse(options.body as string);
      expect(request).toMatchObject({ method: "orcus_sponsorUserOperation", params: [{ chainId: 11155111, entryPointAddress: input.entryPointAddress, shouldOverrideFee: false, shouldConsume: index === 1, userOp: { nonce: "0x0", callGasLimit: "0xa" } }] });
      expect(request.params[0].userOp).not.toHaveProperty("context");
      expect(request.params[0].userOp).not.toHaveProperty("chainId");
    }
  });
  it("rejects cross-origin and credential-bearing endpoints before requesting approval", () => {
    vi.stubGlobal("window", { location: { origin: "https://orcus.example" } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const url of ["https://rpc.zerodev.app/project", "https://operator.example/paymaster", "https://name:secret@orcus.example/api/paymaster"]) expect(() => browserGasSponsorship(url, "300")).toThrow(expect.objectContaining({ code: "SPONSORSHIP_UNCONFIGURED" }));
    expect(fetch).not.toHaveBeenCalled();
  });
});
