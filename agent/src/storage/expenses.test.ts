import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcProvider, Wallet, keccak256, type Network } from "ethers";
import { boundedStorageSigner, reconcileStorageExpense } from "./expenses";

const key = `0x${"1".padStart(64, "0")}`, payer = new Wallet(key).address, flow = `0x${"2".repeat(40)}`, root = `0x${"3".repeat(64)}`;
const signed = "0x1234", hash = keccak256(signed), data = "0x123456780000";
let provider: { getBalance: ReturnType<typeof vi.fn>; broadcastTransaction: ReturnType<typeof vi.fn>; getTransactionReceipt: ReturnType<typeof vi.fn>; getTransaction: ReturnType<typeof vi.fn> };
const request = () => ({ chainId: 16602n, to: flow, data, gasLimit: 20_000n, gasPrice: 2n, value: 100n });
const guard = (options: Parameters<typeof boundedStorageSigner>[3] = {}) => { const value = boundedStorageSigner(key, provider as unknown as JsonRpcProvider, root, options); value.allowFlow(flow, "0x12345678"); return value; };
beforeEach(() => {
  provider = { getBalance: vi.fn().mockResolvedValue(10n ** 18n), broadcastTransaction: vi.fn().mockResolvedValue({ hash }), getTransactionReceipt: vi.fn().mockResolvedValue({ hash, status: 1, gasUsed: 20_000n, gasPrice: 2n, blockNumber: 1 }), getTransaction: vi.fn().mockResolvedValue({ hash, from: payer, to: flow, chainId: 16602n, data, value: 100n }) };
  vi.spyOn(Wallet.prototype, "populateTransaction").mockImplementation(async () => request());
  vi.spyOn(Wallet.prototype, "signTransaction").mockResolvedValue(signed);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("native storage expense guard", () => {
  it("enforces independent gas and storage-fee caps before signing", async () => {
    await expect(guard({ maxGas0G: "0.00000000000001" }).signer.sendTransaction({})).rejects.toMatchObject({ code: "STORAGE_EXPENSE_CAP" });
    await expect(guard({ maxStorageFee0G: "0.000000000000000001" }).signer.sendTransaction({})).rejects.toMatchObject({ code: "STORAGE_EXPENSE_CAP" });
    expect(Wallet.prototype.signTransaction).not.toHaveBeenCalled(); expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });
  it("restricts the signer to one Galileo Flow submit transaction", async () => {
    vi.mocked(Wallet.prototype.populateTransaction).mockResolvedValueOnce({ ...request(), chainId: 16661n });
    await expect(guard().signer.sendTransaction({})).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_MISMATCH" });
    vi.mocked(Wallet.prototype.populateTransaction).mockResolvedValueOnce({ ...request(), data: "0xdeadbeef" });
    await expect(guard().signer.sendTransaction({})).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_MISMATCH" });
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });
  it("persists the candidate hash first and does not repeat an ambiguous write", async () => {
    const persisted = vi.fn(); provider.broadcastTransaction.mockImplementation(async () => { expect(persisted).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: hash, rootHash: root, status: "submitted-unknown" })); throw new Error("timeout"); });
    const attempt = guard({ onSubmissionIntent: persisted });
    await expect(attempt.signer.sendTransaction({})).rejects.toThrow("timeout");
    await expect(attempt.signer.sendTransaction({})).rejects.toMatchObject({ code: "STORAGE_RETRY_BLOCKED" });
    expect(provider.broadcastTransaction).toHaveBeenCalledOnce();
  });
  it("rechecks authority after persisting the signed hash but before broadcast", async () => {
    const authority = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    const attempt = guard({ assertAuthority: authority, onSubmissionIntent: vi.fn() });
    await expect(attempt.signer.sendTransaction({})).rejects.toThrow("revoked");
    expect(attempt.attempted()).toBe(false); expect(attempt.candidateHash()).toBe(hash); expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    await expect(attempt.expense()).resolves.toMatchObject({ status: "not-submitted", totalSpentWei: "0" });
  });
  it("records receipt gas and storage value in native units, not fictitious USD", async () => {
    const onExpense = vi.fn(), attempt = guard({ onExpense });
    await attempt.signer.sendTransaction({});
    await expect(attempt.expense()).resolves.toMatchObject({ kind: "storage", currency: "0g", status: "confirmed", gasPaidWei: "40000", storageFeeWei: "100", totalSpentWei: "40100", payerAddress: payer, rootHash: root });
    await attempt.expense(); expect(onExpense).toHaveBeenCalledOnce();
  });
  it("keeps absent receipts unknown and does not claim the storage fee on revert", async () => {
    provider.getTransactionReceipt.mockResolvedValueOnce(null);
    const attempt = guard(); await attempt.signer.sendTransaction({});
    await expect(attempt.expense()).resolves.toMatchObject({ status: "submitted-unknown" });
    provider.getTransactionReceipt.mockResolvedValueOnce({ hash, status: 0, gasUsed: 20_000n, gasPrice: 2n, blockNumber: 1 });
    await expect(attempt.expense()).resolves.toMatchObject({ status: "reverted", storageFeeWei: "0", totalSpentWei: "40000" });
  });
  it("rejects receipt evidence for another transaction or payer", async () => {
    provider.getTransaction.mockResolvedValueOnce({ hash, from: flow, to: flow, chainId: 16602n, data, value: 100n });
    const attempt = guard(); await attempt.signer.sendTransaction({});
    await expect(attempt.expense()).rejects.toMatchObject({ code: "STORAGE_RECEIPT_MISMATCH" });
  });
  it("reconciles persisted signed metadata without a new signature or upload", async () => {
    const onSubmissionIntent = vi.fn(), attempt = guard({ onSubmissionIntent });
    await attempt.signer.sendTransaction({});
    const saved = onSubmissionIntent.mock.calls[0][0];
    vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({ chainId: 16602n } as Network);
    vi.spyOn(JsonRpcProvider.prototype, "getTransactionReceipt").mockImplementation(async value => Reflect.apply(provider.getTransactionReceipt, provider, [value]));
    vi.spyOn(JsonRpcProvider.prototype, "getTransaction").mockImplementation(async value => Reflect.apply(provider.getTransaction, provider, [value]));
    await expect(reconcileStorageExpense(saved)).resolves.toMatchObject({ status: "confirmed", totalSpentWei: "40100" });
    expect(Wallet.prototype.signTransaction).toHaveBeenCalledOnce(); expect(provider.broadcastTransaction).toHaveBeenCalledOnce();
    await expect(reconcileStorageExpense({ ...saved, calldataHash: `0x${"f".repeat(64)}` })).rejects.toMatchObject({ code: "STORAGE_RECEIPT_MISMATCH" });
    vi.mocked(JsonRpcProvider.prototype.getNetwork).mockResolvedValue({ chainId: 16661n } as Network);
    await expect(reconcileStorageExpense(saved)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
  });
});
