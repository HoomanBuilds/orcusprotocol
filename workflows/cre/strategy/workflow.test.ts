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
  getNetwork: () => ({ chainSelector: { selector: 1n } }),
  median: () => 0,
  encodeCallMsg: (value: unknown) => value,
  ok: () => true,
  text: () => "{}",
  blockNumber: (value: bigint) => value,
  protoBigIntToBigint: (value: bigint) => value,
  cre: { capabilities: {
    HTTPClient: class { sendRequest() { return () => ({ result: () => ({ price: 2000n * 100_000_000n, observedAt: mocks.now }) }); } },
    EVMClient: class {
      static SUPPORTED_CHAIN_SELECTORS = { "ethereum-testnet-sepolia": "test-fixture-selector" };
      headerByNumber() { return { result: () => ({ header: { blockNumber: 10n, timestamp: BigInt(mocks.now / 1000) } }) }; }
      balanceAt = mocks.balanceAt;
      callContract = mocks.callContract;
    },
  } },
}));

import { configSchema, onCron } from "./workflow";
import { decimalAtoms, parsePositiveDecimalE8, sameRequest } from "./values";

function runtime(nativeInput = true, proposalNativeInput = nativeInput) {
  const request = { accountId: "account", venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "sell", amount: "0.01", nativeInput };
  const config = configSchema.parse({ schedule: "0 */5 * * * *", evaluationId: "evaluation", automationId: "automation", accountId: "account", accountAddress: `0x${"1".repeat(40)}`, chainId: 11155111, chainName: "ethereum-testnet-sepolia", tokenAddress: `0x${"2".repeat(40)}`, tokenDecimals: 18, venue: "uniswap", amount: request.amount, request, proposal: { ...request, nativeInput: proposalNativeInput }, proposalId: "proposal", marketUrl: "https://api.coinbase.com/v2/prices/ETH-USD/spot", condition: { operator: "always" }, controlRevision: 0, policyVersion: 1, expiresAt: mocks.now + 60_000 });
  return { config, now: () => new Date(mocks.now), log: vi.fn() } as unknown as Parameters<typeof onCron>[0];
}
const evaluate = (value: Parameters<typeof onCron>[0]) => JSON.parse(onCron(value));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.balanceAt.mockReturnValue({ result: () => ({ balance: 10n ** 18n }) });
  mocks.callContract.mockReturnValue({ result: () => ({ data: hexToBytes(encodeAbiParameters([{ type: "uint256" }], [10n ** 18n])) }) });
});

describe("CRE native input with explicit capability fixtures", () => {
  it("reads native ETH at the observed block rather than requiring WETH", () => {
    const result = evaluate(runtime());
    expect(result).toMatchObject({ decision: "allow", observations: { inputToken: "ETH", inputBalanceAtoms: (10n ** 18n).toString(), blockNumber: "10" } });
    expect(mocks.balanceAt).toHaveBeenCalledWith(expect.anything(), { account: Buffer.from("1".repeat(40), "hex").toString("base64"), blockNumber: 10n });
    expect(mocks.callContract).not.toHaveBeenCalled();
  });
  it("rejects an insufficient or missing native balance without using a token fallback", () => {
    mocks.balanceAt.mockReturnValueOnce({ result: () => ({ balance: 1n }) }).mockReturnValueOnce({ result: () => ({}) });
    expect(evaluate(runtime()).decision).toBe("reject");
    expect(evaluate(runtime()).decision).toBe("reject");
    expect(mocks.callContract).not.toHaveBeenCalled();
  });
  it("keeps ordinary WETH balance checks and rejects changing ETH into WETH in the proposal", () => {
    expect(evaluate(runtime(false)).decision).toBe("allow");
    expect(mocks.callContract).toHaveBeenCalledOnce();
    expect(mocks.balanceAt).not.toHaveBeenCalled();
    expect(evaluate(runtime(true, false))).toMatchObject({ decision: "reject", reason: "The proposal changes the approved input asset." });
  });
  it("binds the full proposal including slippage, recipient assets, order identity and risk flags", () => {
    for (const [key, value] of Object.entries({ slippageBps: 500, tokenOut: `0x${"3".repeat(40)}`, orderId: "different", reduceOnly: true, leverage: 20, mode: "agent" })) {
      const valueRuntime = runtime();
      Object.assign(valueRuntime.config.proposal!, { [key]: value });
      expect(evaluate(valueRuntime)).toMatchObject({ decision: "reject", reason: "The proposal differs from the approved candidate." });
    }
  });
  it("compares thresholds without floating-point rounding and serializes exact prices", () => {
    const value = runtime();
    value.config.condition = { operator: "above", price: "1999.99999999", maxAgeSeconds: 60 };
    expect(evaluate(value)).toMatchObject({ decision: "allow", observations: { marketPriceUsd: "2000", marketPriceE8: "200000000000" } });
    value.config.condition.price = "2000.00000001";
    expect(evaluate(value).decision).toBe("no-action");
  });
  it("rejects invalid precision rather than rounding input assets", () => {
    const value = runtime();
    value.config.amount = "0.0000000000000000001";
    value.config.request!.amount = value.config.amount;
    value.config.proposal!.amount = value.config.amount;
    expect(() => onCron(value)).toThrow("supported precision");
  });
});

describe("exact workflow decimals", () => {
  it("keeps the receiver-free target closed and never constructs EVM operations", () => {
    const config = configSchema.parse({ mode: "local-simulation", schedule: "0 */5 * * * *", marketUrl: "https://api.coinbase.com/v2/prices/ETH-USD/spot", samplePreviousPrice: "1999" });
    const output = evaluate({ config, now: () => new Date(mocks.now), log: vi.fn() } as Parameters<typeof onCron>[0]);
    expect(output).toEqual({ mode: "local-simulation", currentPrice: "2000", previousPrice: "1999", changed: true, wouldWrite: false });
    expect(mocks.balanceAt).not.toHaveBeenCalled();
    expect(mocks.callContract).not.toHaveBeenCalled();
    expect(configSchema.safeParse({ ...config, receiver: `0x${"1".repeat(40)}` }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, mode: "unknown" }).success).toBe(false);
  });
  it("preserves all eight price decimals and rejects excess precision", () => {
    expect(parsePositiveDecimalE8("3500.12345678")).toBe(350012345678n);
    for (const value of ["3500.123456789", "0", "01", "-1", "1e3", " 1", "1.", ".1", (1n << 256n).toString()]) expect(() => parsePositiveDecimalE8(value)).toThrow();
    expect(decimalAtoms("0", 6, true)).toBe(0n);
    expect(() => decimalAtoms("1.0000001", 6)).toThrow();
  });
  it("normalizes omitted native input without ignoring another field", () => {
    expect(sameRequest({ amount: "1" }, { nativeInput: false, amount: "1" })).toBe(true);
    expect(sameRequest({ amount: "1", slippageBps: 50 }, { amount: "1", slippageBps: 500 })).toBe(false);
  });
});
