import { afterEach, describe, expect, it, vi } from "vitest";
import { creChildEnvironment, creRunFailure, parseCreOutput, strategyObservationConfig, withCreRunner, type CreEvaluationInput } from "./cre";
import * as native from "../venues/ostium/data";
import { tradeRequestSchema } from "@orcus/core";
import { OSTIUM_TESTNET } from "@orcus/wallets/ostium";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("CRE runner trust boundary", () => {
  it("rejects cross-market conditions before reading a non-native market", async () => {
    const owner=`0x${"1".repeat(40)}`,account={id:"hl",userId:"owner",venue:"hyperliquid" as const,address:owner,ownerAddress:owner,chainId:421614,status:"connected" as const,controlRevision:0};
    const request=tradeRequestSchema.parse({accountId:account.id,venue:"hyperliquid",type:"market",symbol:"BTC",side:"buy",amount:"0.001"});
    const input:CreEvaluationInput={evaluationId:"mismatch",automationId:"job",account,request,proposal:request,controlRevision:0,policyVersion:1,expiresAt:Date.now()+60_000,condition:{symbol:"ETH",operator:"above",price:"2000"}};
    await expect(strategyObservationConfig(input)).rejects.toMatchObject({code:"CONDITION_MARKET_MISMATCH"});
    await expect(strategyObservationConfig({...input,request:{...request,symbol:"WETH/USDC"}})).resolves.toMatchObject({marketUrl:"https://api.coinbase.com/v2/prices/ETH-USD/spot"});
  });
  it("selects native pair metadata and six-decimal collateral without a guessed Coinbase FX symbol", async () => {
    const getPair = vi.spyOn(native, "getOstiumPair").mockResolvedValue({ pairId: "12" } as Awaited<ReturnType<typeof native.getOstiumPair>>);
    const owner = `0x${"1".repeat(40)}`, account = { id: "native", userId: "owner", venue: "ostium" as const, address: owner, ownerAddress: owner, chainId: 421614, status: "connected" as const, controlRevision: 0 };
    const request = tradeRequestSchema.parse({ accountId: account.id, venue: "ostium", type: "market", symbol: "US100/USD", side: "buy", amount: "10", amountUnit: "collateral-usdc", leverage: 10 });
    const input: CreEvaluationInput = { evaluationId: "native-test", automationId: "job", account, request, proposal: request, controlRevision: 0, policyVersion: 1, expiresAt: Date.now() + 60_000 };
    await expect(strategyObservationConfig(input)).resolves.toMatchObject({ chainName: "ethereum-testnet-sepolia-arbitrum-1", tokenAddress: OSTIUM_TESTNET.usdc, tokenDecimals: 6, marketUrl: "https://builder.prod.bedrock.ostium.io/v1/prices", ostium: { pairId: 12, symbol: "US100/USD" } });
    expect(getPair).toHaveBeenCalledWith("US100/USD");
    await expect(strategyObservationConfig({ ...input, request: { ...request, type: "remove-collateral", positionId: "native-position" } })).rejects.toMatchObject({ code: "OWNER_ONLY" });
    await expect(strategyObservationConfig({ ...input, condition: { symbol: "USD/JPY", operator: "above", price: "150" } })).rejects.toMatchObject({ code: "CONDITION_MARKET_MISMATCH" });
    const spot = { ...input, account: { ...account, venue: "uniswap" as const, chainId: 11155111 }, request: tradeRequestSchema.parse({ accountId: account.id, venue: "uniswap", type: "swap", symbol: "WETH/USDC", side: "sell", amount: "0.01" }), proposal: undefined };
    await expect(strategyObservationConfig(spot)).resolves.toMatchObject({ chainName: "ethereum-testnet-sepolia", marketUrl: "https://api.coinbase.com/v2/prices/ETH-USD/spot" });
  });
  it("keeps signing and compute secrets outside the CLI child", () => {
    vi.stubEnv("ORCUS_MASTER_KEY", "must-not-inherit");
    vi.stubEnv("ZEROG_COMPUTE_API_KEY", "must-not-inherit");
    vi.stubEnv("CRE_API_KEY", "allowed-cli-auth");
    const env = creChildEnvironment();
    expect(env.ORCUS_MASTER_KEY).toBeUndefined();
    expect(env.ZEROG_COMPUTE_API_KEY).toBeUndefined();
    expect(env.CRE_API_KEY).toBe("allowed-cli-auth");
  });
  it("parses structured local output and rejects missing or hosted evidence", () => {
    const output = { evaluationId: "evaluation", automationId: "job", accountId: "account", chainId: 11155111, decision: "allow", reason: "condition met", source: "local-simulation", observedAt: 1, expiresAt: 2, controlRevision: 1, policyVersion: 1 };
    expect(parseCreOutput(`runner: ORCUS_CRE_RESULT=${JSON.stringify(output)}`).decision).toBe("allow");
    expect(() => parseCreOutput("no workflow result")).toThrow("no authenticated evaluation");
    expect(() => parseCreOutput(`ORCUS_CRE_RESULT=${JSON.stringify({ ...output, source: "hosted" })}`)).toThrow("malformed or unsupported");
  });
  it("reassembles bounded CRE log parts and rejects truncated, reordered or mixed results", () => {
    const output = { evaluationId: "evaluation", automationId: "job", accountId: "account", chainId: 421614, decision: "allow", reason: "condition met", source: "local-simulation", observedAt: 1, expiresAt: 2, controlRevision: 1, policyVersion: 1, observations: { source: "public observation".repeat(80) } };
    const payload = JSON.stringify(output), bytes = Buffer.from(payload), chunks = Array.from({ length: Math.ceil(bytes.length / 512) }, (_, index) => bytes.subarray(index * 512, (index + 1) * 512).toString("base64")), lines = chunks.map((part, index) => `runner: ORCUS_CRE_RESULT_PART=${index + 1}/${chunks.length}:${part}`);
    expect(parseCreOutput(lines.join("\n"))).toEqual(output);
    for (const invalid of [lines.slice(1), [...lines].reverse(), [...lines, lines[0]], [...lines, ...lines], [...lines, `ORCUS_CRE_RESULT=${payload}`], ["ORCUS_CRE_RESULT_PART=1/1:" + "x".repeat(685)], ["ORCUS_CRE_RESULT_PART=1/1:/w=="]]) expect(() => parseCreOutput(invalid.join("\n"))).toThrow("malformed or unsupported");
    expect(() => parseCreOutput(lines.join("\n").slice(0, -1))).toThrow("malformed or unsupported");
  });
  it("normalizes an absent preset-strategy inference ID before backend binding", () => {
    const output = { evaluationId: "evaluation", automationId: "job", accountId: "account", chainId: 11155111, decision: "allow", reason: "condition met", source: "local-simulation", observedAt: 1, expiresAt: 2, controlRevision: 1, policyVersion: 1 };
    const parse = (requestId?: string) => parseCreOutput(`ORCUS_CRE_RESULT=${JSON.stringify({ ...output, requestId })}`);
    expect(parse().requestId).toBeUndefined();
    expect(parse("").requestId).toBeUndefined();
    expect(parse("real-provider-request").requestId).toBe("real-provider-request");
  });
  it("serializes shared workflow builds and rejects excess queued evaluations", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const events: string[] = [], expiresAt = Date.now() + 60_000;
    const first = withCreRunner("shared-workflow", expiresAt, async () => { events.push("first"); await gate; return "first-result"; });
    const second = withCreRunner("shared-workflow", expiresAt, async () => { events.push("second"); return "second-result"; });
    await expect(withCreRunner("shared-workflow", expiresAt, async () => "never")).rejects.toMatchObject({ code: "CRE_RUNNER_BUSY" });
    expect(events).toEqual(["first"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["first-result", "second-result"]);
    expect(events).toEqual(["first", "second"]);
    await expect(withCreRunner("shared-workflow", expiresAt, async () => "released")).resolves.toBe("released");
  });
  it("rechecks expiry after waiting without starting the stale operation", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), operation = vi.fn(async () => "must-not-run");
    const first = withCreRunner("expiring-workflow", 5_000, () => gate);
    const second = withCreRunner("expiring-workflow", 1_500, operation);
    const rejected = expect(second).rejects.toMatchObject({ code: "STALE_EVALUATION" });
    clock.mockReturnValue(2_000);
    release();
    await Promise.all([first, rejected]);
    expect(operation).not.toHaveBeenCalled();
    await expect(withCreRunner("expiring-workflow", 5_000, async () => "released")).resolves.toBe("released");
  });
  it("releases a failed build and keeps independent workflow directories unblocked", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), expiresAt = Date.now() + 60_000;
    const first = withCreRunner("failing-workflow", expiresAt, async () => { await gate; throw new Error("failed build"); });
    const rejected = expect(first).rejects.toThrow("failed build");
    const second = withCreRunner("failing-workflow", expiresAt, async () => "next-result");
    await expect(withCreRunner("other-workflow", expiresAt, async () => "independent")).resolves.toBe("independent");
    release();
    await rejected;
    await expect(second).resolves.toBe("next-result");
  });
  it.each([
    [{ code: "ENOENT" }, "CRE_CLI_UNAVAILABLE"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "CRE_OUTPUT_LIMIT"],
    [{ killed: true }, "CRE_RUN_TIMEOUT"],
    [{ stderr: "authentication required secret-value" }, "CRE_AUTH_REQUIRED"],
    [{ stdout: "failed to compile: cannot find .cre_build_tmp.js secret-value" }, "CRE_BUILD_CONFLICT"],
    [{ stderr: "compilation failed secret-value" }, "CRE_BUILD_FAILED"],
    [{ stderr: "unrecognized upstream failure secret-value" }, "CRE_RUN_FAILED"],
    [null, "CRE_RUN_FAILED"],
  ])("classifies CLI failure without exposing raw logs: %s", (error, code) => {
    const failure = creRunFailure(error);
    expect(failure.code).toBe(code);
    expect(failure.message).not.toContain("secret-value");
  });
});
