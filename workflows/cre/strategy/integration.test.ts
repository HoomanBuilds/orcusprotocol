import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tradeRequestSchema, type PreparedAction } from "@orcus/core";

const fixtures = vi.hoisted(() => ({
  collateral: "100",
  simulate: undefined as undefined | ((file: string, args: string[], options: unknown) => Promise<{ stdout: string; stderr: string }>),
}));

vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: [string, string[], unknown]) => fixtures.simulate!(...args),
  }),
}));

vi.mock("@chainlink/cre-sdk", () => ({
  ConsensusAggregationByFields: () => ({}),
  LATEST_BLOCK_NUMBER: "latest",
  blockNumber: (value: bigint) => value,
  bytesToBase64: (value: Uint8Array) => Buffer.from(value).toString("base64"),
  bytesToHex: (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`,
  consensusIdenticalAggregation: () => ({}),
  consensusMedianAggregation: () => ({}),
  encodeCallMsg: (value: unknown) => value,
  getNetwork: () => undefined,
  identical: () => 0,
  median: () => 0,
  ok: (response: { statusCode: number }) => response.statusCode >= 200 && response.statusCode < 300,
  protoBigIntToBigint: (value: bigint) => value,
  text: (response: { body: Uint8Array }) => new TextDecoder().decode(response.body),
  cre: { capabilities: {
    HTTPClient: class {
      sendRequest(runtime: { config: { accountAddress: string } }, reader: (requester: unknown, ...args: unknown[]) => unknown) {
        return (...args: unknown[]) => ({ result: () => reader({ sendRequest: (request: { url: string; body: string }) => ({ result: () => {
          if (!["https://api.coinbase.com/v2/prices/ETH-USD/spot", "https://api.hyperliquid-testnet.xyz/info"].includes(request.url)) throw new Error("Unexpected fixture capability URL");
          if (request.url.endsWith("/info")) expect(JSON.parse(Buffer.from(request.body, "base64").toString("utf8"))).toEqual({ type: "clearinghouseState", user: runtime.config.accountAddress });
          const body = request.url.endsWith("/spot") ? { data: { amount: "2000", currency: "USD" } } : { marginSummary: { accountValue: fixtures.collateral } };
          return { statusCode: 200, body: new TextEncoder().encode(JSON.stringify(body)), headers: { date: new Date().toUTCString() }, multiHeaders: {} };
        } }) }, ...args) });
      }
    },
  } },
}));

import { planWith0G } from "../../../agent/src/compute";
import type { AgentContext } from "../../../agent/src/compute/types";
import { evaluateStrategy, type CreEvaluationInput } from "../../../agent/src/automation/cre";
import * as boundary from "../../../packages/server/src/engine";
import { setBudget } from "../../../packages/server/src/budget";
import { Platform } from "../../../packages/server/src/platform";
import { Store } from "../../../packages/server/src/store";
import type { StoredAction, StoredAutomation, StoredPermission } from "../../../packages/server/src/types";
import { configSchema, onCron } from "./workflow";

let directory: string;
const stores: Store[] = [];
const computeUrl = "https://inference.fixture.test/v1/chat/completions";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orcus-joined-fixture-"));
  vi.stubEnv("ORCUS_DATA_DIR", directory);
  vi.stubEnv("ORCUS_MASTER_KEY", randomBytes(32).toString("hex"));
  vi.stubEnv("ZEROG_COMPUTE_CHAT_URL", computeUrl);
  vi.stubEnv("ZEROG_COMPUTE_API_KEY", "fixture-inference-key");
  vi.stubEnv("ZEROG_COMPUTE_MODEL", "fixture-model");
  vi.stubEnv("CRE_ENABLED", "true");
  vi.stubEnv("CRE_WORKFLOW_DIR", directory);
  vi.stubEnv("LANGSMITH_TRACING", "false");
  vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
  fixtures.collateral = "100";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fixtures.simulate = undefined;
  for (const store of stores.splice(0)) store.db.close();
  rmSync(directory, { recursive: true, force: true });
});

async function harness(afterDecision?: (value: Record<string, unknown>) => void) {
  const store = new Store(":memory:");
  stores.push(store);
  const user = store.ensureUser("0x1111111111111111111111111111111111111111"), platform = new Platform(store);
  const account = platform.createAccount(user, { venue: "hyperliquid" });
  const request = tradeRequestSchema.parse({ accountId: account.id, venue: "hyperliquid", type: "market", symbol: "ETH", side: "buy", amount: "0.01", slippageBps: 50, mode: "agent" });
  const automation = { kind: "trade", accountId: account.id, name: "Joined fixture strategy", request, condition: { symbol: "ETH", operator: "below", price: "2100" }, executionMode: "once", maxExecutions: 1, intervalSeconds: 60 };
  const decisions = [{ type: "tool", name: "propose_automation", arguments: { automation } }, { type: "final", message: "Review this once-only ETH strategy before enabling it.", requiresClarification: false }];
  let modelCalls = 0;
  const provider = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe(computeUrl);
    const index = modelCalls++;
    if (!decisions[index]) throw new Error("Unexpected extra fixture inference");
    return Response.json({ id: `fixture-provider-${index + 1}`, choices: [{ message: { content: JSON.stringify(decisions[index]) } }], x_0g_trace: { request_id: `fixture-provider-${index + 1}`, billing: { currency: "usd", input_cost: "1", output_cost: "1", total_cost: "2", total_cost_usd_micro: "2" } } });
  });
  vi.stubGlobal("fetch", provider);
  vi.spyOn(platform, "verifyHyperliquidApproval").mockResolvedValue();
  const grant = await platform.permission(user, { accountId: account.id, action: "prepare", allowedActions: ["market"], allowedSymbols: ["ETH"], maxTradeUsd: "100" });
  await platform.permission(user, { accountId: account.id, action: "activate", permissionId: grant.permission!.id });
  setBudget(store, user.id, "1", "0", false);
  const submit = vi.fn(async (prepared: PreparedAction, _account: unknown, _key: unknown, options: { assertAuthority: () => void }) => {
    options.assertAuthority();
    expect(prepared.request).toEqual(request);
    expect(prepared.account.id).toBe(account.id);
    return { status: "pending", orderId: "fixture-order" };
  });
  const cli = vi.fn(async (_file: string, args: string[]) => {
    expect(args.slice(0, 5)).toEqual(["workflow", "simulate", "strategy", "--target", "staging-settings"]);
    expect(args).not.toContain("--broadcast");
    const config = configSchema.parse(JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8")));
    if (config.mode !== "strategy") throw new Error("The joined fixture expects the real strategy configuration");
    const lines: string[] = [];
    const result = JSON.parse(onCron({ config, now: () => new Date(), log: (line: string) => lines.push(line) } as Parameters<typeof onCron>[0]));
    const originalResult = JSON.stringify(result);
    afterDecision?.(result);
    if (JSON.stringify(result) !== originalResult) return { stdout: `ORCUS_CRE_RESULT=${JSON.stringify(result)}`, stderr: "" };
    return { stdout: lines.join("\n"), stderr: "" };
  });
  fixtures.simulate = cli;
  const engine = vi.spyOn(boundary, "callEngine").mockImplementation(async (name, ...args) => {
    if (name === "planWith0G") return planWith0G(args[0] as string, args[1] as AgentContext);
    if (name === "evaluateStrategy") return evaluateStrategy(args[0] as CreEvaluationInput);
    if (name === "getPortfolio") return { accountId: account.id, balances: [], positions: [], orders: [], observedAt: Date.now() };
    if (name === "getMarkets") return [{ venue: account.venue, symbol: "ETH", baseAsset: "ETH", quoteAsset: "USDC", midPrice: "2000", observedAt: Date.now() }];
    if (name === "prepareAction") return { id: "fixture-prepared", request: tradeRequestSchema.parse(args[0]), account: args[1], kind: "hyperliquid", expiresAt: Date.now() + 60_000, controlRevision: account.controlRevision } as PreparedAction;
    if (name === "submitAgentAction") return submit(...args as Parameters<typeof submit>);
    if (name === "reconcileAction") return { status: "confirmed", orderId: "fixture-order", evidence: { fixture: true } };
    throw new Error(`Unexpected joined fixture boundary: ${name}`);
  });
  const draft = await platform.chat(user, { requestId: "fixture-owner-review", accountId: account.id, message: "Prepare buying 0.01 ETH once when ETH is below 2100. Ask me to review before enabling it." });
  expect(draft.automationProposal).toMatchObject(automation);
  expect(store.list(user.id, "automation")).toHaveLength(0);
  expect(store.list(user.id, "action")).toHaveLength(0);
  const job = platform.createAutomation(user, draft.automationProposal, `chat-automation:${draft.message.id}`);
  return { store, user, platform, account, request, grant, job, provider, cli, engine, submit };
}

describe("joined planning, workflow and execution wiring with external fixtures", () => {
  it("binds an owner-accepted typed draft through CRE without replanning or repeating its trade", async () => {
    const h = await harness();
    await h.platform.tick();
    const evaluation = h.store.list<{ id: string; requestId: string }>(h.user.id, "evaluation")[0];
    const action = h.store.list<StoredAction>(h.user.id, "action")[0];
    expect(evaluation).toMatchObject({ automationId: h.job.id, accountId: h.account.id, decision: "allow", requestId: "fixture-provider-1", source: "local-simulation" });
    expect(action).toMatchObject({ accountId: h.account.id, automationId: h.job.id, request: h.request, status: "confirmed", providerRequestId: evaluation.requestId, audit: { evaluationId: evaluation.id, providerRequestId: evaluation.requestId, permission: { decision: "allowed", permissionId: h.grant.permission!.id } } });
    expect(h.provider).toHaveBeenCalledTimes(2);
    expect(h.cli).toHaveBeenCalledOnce();
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.store.get(h.user.id, "automation", h.job.id)).toMatchObject({ status: "completed", executionCount: 1 });
    await h.platform.tick();
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.provider).toHaveBeenCalledTimes(2);
  });

  it("does not prepare or submit the proposal when CRE rejects the observed collateral", async () => {
    const h = await harness();
    fixtures.collateral = "0";
    await h.platform.tick();
    expect(h.store.list(h.user.id, "evaluation")).toEqual([expect.objectContaining({ decision: "reject", requestId: "fixture-provider-1" })]);
    expect(h.store.list(h.user.id, "action")).toHaveLength(0);
    expect(h.engine.mock.calls.some(([name]) => name === "prepareAction")).toBe(false);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("rechecks permission after an allowed workflow decision before reaching the signer", async () => {
    const h = await harness(() => {
      h.store.update<StoredPermission>(h.user.id, "permission", h.grant.permission!.id, { status: "revoked" });
    });
    await h.platform.tick();
    expect(h.store.list(h.user.id, "evaluation")).toEqual([expect.objectContaining({ decision: "allow" })]);
    expect(h.store.get<StoredAutomation>(h.user.id, "automation", h.job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Authorize this agent") });
    expect(h.store.list(h.user.id, "action")).toHaveLength(0);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("rejects a CRE result carrying a different provider identity", async () => {
    const h = await harness(result => { result.requestId = "fixture-different-provider"; });
    await h.platform.tick();
    expect(h.store.list(h.user.id, "evaluation")).toHaveLength(0);
    expect(h.store.get<StoredAutomation>(h.user.id, "automation", h.job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("does not match") });
    expect(h.store.list(h.user.id, "action")).toHaveLength(0);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("rejects a CRE result evaluating a different threshold than the owner accepted", async () => {
    const h = await harness(result => { result.condition = { symbol: "ETH", operator: "below", price: "9999", maxAgeSeconds: 60 }; });
    await h.platform.tick();
    expect(h.store.list(h.user.id, "evaluation")).toHaveLength(0);
    expect(h.store.get<StoredAutomation>(h.user.id, "automation", h.job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("condition") });
    expect(h.submit).not.toHaveBeenCalled();
  });
});
