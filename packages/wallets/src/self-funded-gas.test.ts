import { describe, expect, it, vi } from "vitest";
import { assertAvailableAccountGas, assertSelfFundedOperation, checkAccountGas } from "./self-funded-gas";

const sender = "0x1111111111111111111111111111111111111111";
const operation = { sender, callGasLimit: 10n, verificationGasLimit: 20n, preVerificationGas: 30n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };

describe("self-funded smart-account gas", () => {
  it("caps the full operation rather than its transaction call gas only", () => {
    expect(assertSelfFundedOperation(operation, "120")).toBe(120n);
    expect(() => assertSelfFundedOperation(operation, "119")).toThrow(expect.objectContaining({ code: "GAS_LIMIT_EXCEEDED" }));
  });
  it("rejects sponsor data even when a stale configuration attaches it", () => {
    for (const key of ["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterAndData"]) {
      expect(() => assertSelfFundedOperation({ ...operation, [key]: "0x" })).toThrow(expect.objectContaining({ code: "SPONSORSHIP_DISABLED" }));
    }
  });
  it("fails closed on missing, negative and overflowing gas or fees", () => {
    for (const patch of [{ callGasLimit: undefined }, { maxFeePerGas: 0n }, { verificationGasLimit: -1n }, { preVerificationGas: 2n ** 128n }, { maxPriorityFeePerGas: 3n }]) expect(() => assertSelfFundedOperation({ ...operation, ...patch })).toThrow();
  });
  it("allows EntryPoint funds for gas, but not for ETH being traded", () => {
    expect(() => assertAvailableAccountGas(100n, 120n, 120n, 100n)).not.toThrow();
    expect(() => assertAvailableAccountGas(99n, 1000n, 120n, 100n)).toThrow();
    expect(() => assertAvailableAccountGas(220n, 0n, 120n, 100n)).not.toThrow();
    expect(() => assertAvailableAccountGas(219n, 0n, 120n, 100n)).toThrow(expect.objectContaining({ code: "SMART_ACCOUNT_GAS_INSUFFICIENT" }));
    expect(() => assertAvailableAccountGas(170n, 50n, 120n, 100n)).not.toThrow();
  });
  it("reads the trading account and its EntryPoint deposit, never the signing key wallet", async () => {
    const client = { getBalance: vi.fn().mockResolvedValue(100n), readContract: vi.fn().mockResolvedValue(120n) };
    await expect(checkAccountGas(client as never, sender, operation, 100n)).resolves.toMatchObject({ maximumGasWei: 120n });
    expect(client.getBalance).toHaveBeenCalledWith({ address: sender });
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "balanceOf", args: [sender] }));
    client.getBalance.mockRejectedValue(new Error("secret RPC details"));
    await expect(checkAccountGas(client as never, sender, operation, 0n)).rejects.toMatchObject({ code: "GAS_BALANCE_UNAVAILABLE" });
  });
});
