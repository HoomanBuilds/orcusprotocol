import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, hexToBytes } from "viem";

const mocks = vi.hoisted(() => ({ balanceAt: vi.fn(), callContract: vi.fn(), now: 1_800_000_000_000 }));
vi.mock("@chainlink/cre-sdk", () => ({
  ConsensusAggregationByFields: () => ({}),
  LATEST_BLOCK_NUMBER: "latest",
  bytesToBase64: (value: Uint8Array) => Buffer.from(value).toString("base64"),
  bytesToHex: (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`,
  consensusIdenticalAggregation: () => ({}),
  consensusMedianAggregation: () => ({}),
  median: () => 0,
  encodeCallMsg: (value: unknown) => value,
  ok: () => true,
  text: () => "{}",
  blockNumber: (value: bigint) => value,
  protoBigIntToBigint: (value: bigint) => value,
  cre: { capabilities: {
    HTTPClient: class { sendRequest() { return () => ({ result: () => ({ price: 2000, observedAt: mocks.now }) }); } },
    EVMClient: class {
      static SUPPORTED_CHAIN_SELECTORS = { "ethereum-testnet-sepolia": "test-fixture-selector" };
      headerByNumber() { return { result: () => ({ header: { blockNumber: 10n, timestamp: BigInt(mocks.now / 1000) } }) }; }
      balanceAt = mocks.balanceAt;
      callContract = mocks.callContract;
    },
  } },
}));

import { configSchema, onCron } from "./workflow";

function runtime(nativeInput = true, proposalNativeInput = nativeInput) {
  const request = { accountId: "account", venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "sell", amount: "0.01", nativeInput };
  const config = configSchema.parse({ schedule: "0 */5 * * * *", evaluationId: "evaluation", automationId: "automation", accountId: "account", accountAddress: `0x${"1".repeat(40)}`, chainId: 11155111, chainName: "ethereum-testnet-sepolia", tokenAddress: `0x${"2".repeat(40)}`, tokenDecimals: 18, venue: "uniswap", amount: request.amount, request, proposal: { ...request, nativeInput: proposalNativeInput }, proposalId: "proposal", marketUrl: "https://api.coinbase.com/v2/prices/ETH-USD/spot", condition: { operator: "always" }, controlRevision: 0, policyVersion: 1, expiresAt: mocks.now + 60_000 });
  return { config, now: () => new Date(mocks.now), log: vi.fn() } as unknown as Parameters<typeof onCron>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.balanceAt.mockReturnValue({ result: () => ({ balance: 10n ** 18n }) });
  mocks.callContract.mockReturnValue({ result: () => ({ data: hexToBytes(encodeAbiParameters([{ type: "uint256" }], [10n ** 18n])) }) });
});

describe("CRE native input with explicit capability fixtures", () => {
  it("reads native ETH at the observed block rather than requiring WETH", () => {
    const result = onCron(runtime());
    expect(result).toMatchObject({ decision: "allow", observations: { inputToken: "ETH", inputBalanceAtoms: (10n ** 18n).toString(), blockNumber: "10" } });
    expect(mocks.balanceAt).toHaveBeenCalledWith(expect.anything(), { account: Buffer.from("1".repeat(40), "hex").toString("base64"), blockNumber: 10n });
    expect(mocks.callContract).not.toHaveBeenCalled();
  });
  it("rejects an insufficient or missing native balance without using a token fallback", () => {
    mocks.balanceAt.mockReturnValueOnce({ result: () => ({ balance: 1n }) }).mockReturnValueOnce({ result: () => ({}) });
    expect(onCron(runtime()).decision).toBe("reject");
    expect(onCron(runtime()).decision).toBe("reject");
    expect(mocks.callContract).not.toHaveBeenCalled();
  });
  it("keeps ordinary WETH balance checks and rejects changing ETH into WETH in the proposal", () => {
    expect(onCron(runtime(false)).decision).toBe("allow");
    expect(mocks.callContract).toHaveBeenCalledOnce();
    expect(mocks.balanceAt).not.toHaveBeenCalled();
    expect(onCron(runtime(true, false))).toMatchObject({ decision: "reject", reason: "The proposal changes the approved input asset." });
  });
});
