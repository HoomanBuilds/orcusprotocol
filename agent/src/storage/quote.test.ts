import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcProvider, type Network } from "ethers";
import { quoteEncryptedUpload } from "./quote";

const mock = vi.hoisted(() => ({ select: vi.fn(), status: vi.fn(), price: vi.fn(), estimate: vi.fn(), submission: vi.fn() }));
vi.mock("@0gfoundation/0g-storage-ts-sdk", () => ({
  Indexer: class { selectNodes = mock.select; },
  MemData: class { createSubmission = mock.submission; },
  FixedPriceFlow__factory: { connect: () => ({ market: async () => `0x${"2".repeat(40)}`, getFunction: () => ({ estimateGas: mock.estimate }) }) },
  getMarketContract: () => ({ pricePerSector: mock.price }),
}));
const payer = `0x${"1".repeat(40)}`, flow = `0x${"3".repeat(40)}`;
const bytes = Buffer.concat([Buffer.from("ORCUSMEM1"), Buffer.alloc(28), Buffer.from("{}")]);
beforeEach(() => {
  vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({ chainId: 16602n } as Network);
  vi.spyOn(JsonRpcProvider.prototype, "getCode").mockResolvedValue("0x01");
  vi.spyOn(JsonRpcProvider.prototype, "getBalance").mockResolvedValue(1000n);
  vi.spyOn(JsonRpcProvider.prototype, "getFeeData").mockResolvedValue({ gasPrice: 3n, maxFeePerGas: null, maxPriorityFeePerGas: null, toJSON: () => ({}) });
  mock.select.mockResolvedValue([[{ getStatus: mock.status }], null]);
  mock.status.mockResolvedValue({ networkIdentity: { chainId: 16602, flowAddress: flow } });
  mock.submission.mockResolvedValue([{ data: { nodes: [{ height: 1n }, { height: 0n }] } }, null]);
  mock.price.mockResolvedValue(2n);
  mock.estimate.mockResolvedValue(100n);
});
afterEach(() => { vi.restoreAllMocks(); mock.select.mockClear(); mock.estimate.mockClear(); });

describe("read-only encrypted storage quotes", () => {
  it("quotes exact native fee and padded gas without a signer or transaction", async () => {
    const quote = await quoteEncryptedUpload(bytes, payer);
    expect(quote).toMatchObject({ chainId: 16602, storageFeeWei: "6", gasLimit: "120", maximumEstimatedGasWei: "360", estimatedTotalWei: "366", canAfford: true, transactionsSubmitted: 0 });
    expect(mock.estimate).toHaveBeenCalledWith(expect.any(Object), { from: payer, value: 6n, gasPrice: 3n });
  });
  it("rejects unencrypted or oversized input before network discovery", async () => {
    await expect(quoteEncryptedUpload(Buffer.from("private plaintext"), payer)).rejects.toMatchObject({ code: "INVALID_MEMORY" });
    await expect(quoteEncryptedUpload(Buffer.alloc(1_000_038), payer)).rejects.toMatchObject({ code: "INVALID_MEMORY" });
    expect(mock.select).not.toHaveBeenCalled();
  });
  it("refuses a different chain, absent contract or wrong storage-node identity", async () => {
    vi.mocked(JsonRpcProvider.prototype.getNetwork).mockResolvedValueOnce({ chainId: 16661n } as Network);
    await expect(quoteEncryptedUpload(bytes, payer)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    mock.status.mockResolvedValueOnce({ networkIdentity: { chainId: 16661, flowAddress: flow } });
    await expect(quoteEncryptedUpload(bytes, payer)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    vi.mocked(JsonRpcProvider.prototype.getCode).mockResolvedValueOnce("0x");
    await expect(quoteEncryptedUpload(bytes, payer)).rejects.toMatchObject({ code: "INVALID_STORAGE_FLOW" });
  });
  it("reports insufficient funds without claiming free or funded storage", async () => {
    vi.mocked(JsonRpcProvider.prototype.getBalance).mockResolvedValueOnce(0n);
    expect((await quoteEncryptedUpload(bytes, payer)).canAfford).toBe(false);
    mock.select.mockResolvedValueOnce([[], new Error("offline")]);
    await expect(quoteEncryptedUpload(bytes, payer)).rejects.toMatchObject({ code: "STORAGE_SELECTION_FAILED" });
  });
});
