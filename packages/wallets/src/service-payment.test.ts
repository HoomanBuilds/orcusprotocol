import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, type EIP1193Provider, type Hex } from "viem";
import { assertServicePaymentQuote, payServiceCredits, type ServicePaymentQuote } from "./service-payment";

const mocks = vi.hoisted(() => ({ simulate: vi.fn(), send: vi.fn(), chain: vi.fn(), switchChain: vi.fn(), read: vi.fn(), gas: vi.fn(), fees: vi.fn(), balance: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ simulateContract: mocks.simulate, readContract: mocks.read, estimateGas: mocks.gas, estimateFeesPerGas: mocks.fees, getBalance: mocks.balance }), createWalletClient: () => ({ getChainId: mocks.chain, switchChain: mocks.switchChain, sendTransaction: mocks.send }) }));
const payer = `0x${"1".repeat(40)}` as Hex, treasury = `0x${"2".repeat(40)}` as Hex, token = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", hash = `0x${"a".repeat(64)}` as Hex;
const quote = (): ServicePaymentQuote => ({ id: "service-payment:test", mode: "testnet", testOnly: true, chainId: 11155111, token, payer, treasury, amountBaseUnits: "1000000", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [treasury, 1_000_000n] }), value: "0", status: "prepared", expiresAt: Date.now() + 60_000 });
const provider = { request: vi.fn(async ({ method }: { method: string }) => method === "eth_accounts" ? [payer] : "0xaa36a7") } as unknown as EIP1193Provider;
beforeEach(() => { vi.clearAllMocks(); mocks.simulate.mockResolvedValue({ result: true }); mocks.chain.mockResolvedValue(11155111); mocks.send.mockResolvedValue(hash); mocks.read.mockResolvedValue(2_000_000n); mocks.gas.mockResolvedValue(50_000n); mocks.fees.mockResolvedValue({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }); mocks.balance.mockResolvedValue(1_000_000_000_000_000_000n); });
afterEach(() => vi.restoreAllMocks());

describe("owner-signed testnet service payment", () => {
  it("accepts only an exact fresh test-USDC transfer quote for the signed-in owner", () => {
    expect(() => assertServicePaymentQuote(quote(), payer)).not.toThrow();
    for (const patch of [{ mode: "live" }, { chainId: 1 }, { token: treasury }, { payer: treasury }, { value: "1" }, { status: "submitted" }, { expiresAt: Date.now() - 1 }, { amountBaseUnits: "0" }, { amountBaseUnits: "100000001" }, { amountBaseUnits: "1e6" }, { data: "0x1234" }]) expect(() => assertServicePaymentQuote({ ...quote(), ...patch } as ServicePaymentQuote, payer)).toThrow();
  });
  it("simulates then records a durable pending intent before asking the owner wallet to send", async () => {
    const events: string[] = [], beforeSubmit = vi.fn(async () => { events.push("pending"); }), onSubmitted = vi.fn(async () => { events.push("hash"); });
    mocks.send.mockImplementation(async () => { events.push("send"); return hash; });
    await expect(payServiceCredits(quote(), { beforeSubmit, onSubmitted }, provider)).resolves.toEqual({ transactionHash: hash });
    expect(events).toEqual(["pending", "send", "hash"]);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ account: payer, to: expect.stringMatching(/^0x1c7/i), value: 0n, gas: 60_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }));
    expect(onSubmitted).toHaveBeenCalledWith(hash);
  });
  it("does not broadcast if simulation or durable pending-recording fails", async () => {
    mocks.simulate.mockRejectedValueOnce(new Error("simulation failed"));
    await expect(payServiceCredits(quote(), { beforeSubmit: vi.fn(), onSubmitted: vi.fn() }, provider)).rejects.toThrow(/simulation/);
    await expect(payServiceCredits(quote(), { beforeSubmit: vi.fn(async () => { throw new Error("durable record unavailable"); }), onSubmitted: vi.fn() }, provider)).rejects.toThrow(/durable/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("preserves known hashes when recording fails and refuses to call a lost response a failure", async () => {
    await expect(payServiceCredits(quote(), { beforeSubmit: vi.fn(), onSubmitted: vi.fn(async () => { throw new Error(); }) }, provider)).rejects.toMatchObject({ phase: "submitted-unknown", evidence: { transactionHash: hash } });
    mocks.send.mockRejectedValueOnce(new Error("timeout"));
    await expect(payServiceCredits(quote(), { beforeSubmit: vi.fn(), onSubmitted: vi.fn() }, provider)).rejects.toMatchObject({ phase: "submitted-unknown" });
  });
  it("distinguishes explicit wallet rejection from uncertain submission", async () => {
    mocks.send.mockRejectedValueOnce({ code: 4001 });
    await expect(payServiceCredits(quote(), { beforeSubmit: vi.fn(), onSubmitted: vi.fn() }, provider)).rejects.toMatchObject({ code: "OWNER_REJECTED", phase: "not-submitted" });
  });
  it("rejects missing test tokens or Sepolia gas and excessive fee quotes before recording a wallet submission", async () => {
    const beforeSubmit = vi.fn(), hooks = { beforeSubmit, onSubmitted: vi.fn() };
    mocks.read.mockResolvedValueOnce(999_999n);
    await expect(payServiceCredits(quote(), hooks, provider)).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    mocks.balance.mockResolvedValueOnce(1n);
    await expect(payServiceCredits(quote(), hooks, provider)).rejects.toMatchObject({ code: "INSUFFICIENT_GAS" });
    mocks.fees.mockResolvedValueOnce({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1n });
    await expect(payServiceCredits(quote(), hooks, provider)).rejects.toMatchObject({ code: "PREFLIGHT_FAILED" });
    expect(mocks.send).not.toHaveBeenCalled(); expect(beforeSubmit).not.toHaveBeenCalled();
  });
});
