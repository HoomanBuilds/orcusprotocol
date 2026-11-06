import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { automationMarketMatches, type TradeRequest, type TradingAccount } from "@orcus/core";
import { engineConfig } from "../config";
import { EngineError, requireConfigured } from "../errors";
import { OSTIUM_TESTNET } from "@orcus/wallets/ostium";
import { assertOstiumAccount, getOstiumPair } from "../venues/ostium/data";

const run = promisify(execFile);
const workflowRunners = new Map<string, { tail: Promise<void>; count: number }>();

export async function withCreRunner<T>(workflowDir: string, expiresAt: number, operation: () => Promise<T>): Promise<T> {
  const queue = workflowRunners.get(workflowDir) ?? { tail: Promise.resolve(), count: 0 };
  if (queue.count >= 2) throw new EngineError("CRE_RUNNER_BUSY", "The CRE workflow already has an active and waiting evaluation. No new CLI process was started.", 503);
  const previous = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>(resolve => { release = resolve; });
  queue.count++;
  workflowRunners.set(workflowDir, queue);
  await previous;
  try {
    if (expiresAt <= Date.now()) throw new EngineError("STALE_EVALUATION", "The strategy evaluation expired while waiting for the CRE runner. No CLI process was started.", 422);
    return await operation();
  } finally {
    queue.count--;
    release();
    if (!queue.count) workflowRunners.delete(workflowDir);
  }
}

export function creRunFailure(error: unknown): EngineError {
  const failure = error && typeof error === "object" ? error as { code?: unknown; killed?: unknown; stderr?: unknown; stdout?: unknown } : {};
  const text = `${typeof failure.stderr === "string" ? failure.stderr : ""} ${typeof failure.stdout === "string" ? failure.stdout : ""}`;
  if (failure.code === "ENOENT") return new EngineError("CRE_CLI_UNAVAILABLE", "The configured CRE CLI executable was not found. No evaluation result was accepted.", 503);
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new EngineError("CRE_OUTPUT_LIMIT", "The CRE CLI exceeded its output limit. No evaluation result was accepted.", 502);
  if (failure.killed === true) return new EngineError("CRE_RUN_TIMEOUT", "The CRE CLI was stopped or exceeded its runtime limit. No evaluation result was accepted.", 504);
  if (/not logged in|authentication required|CRE_API_KEY/i.test(text)) return new EngineError("CRE_AUTH_REQUIRED", "The CRE CLI requires login or CRE_API_KEY. No strategy trade was authorized.", 503);
  if (/\.cre_build_tmp.*(?:not found|no such|cannot find)|(?:not found|no such|cannot find).*\.cre_build_tmp/i.test(text)) return new EngineError("CRE_BUILD_CONFLICT", "CRE compilation lost a shared build artifact. Run only one CLI process per workflow directory. No evaluation result was accepted.", 503);
  if (/failed to compile|compilation failed|failed to build|error compiling/i.test(text)) return new EngineError("CRE_BUILD_FAILED", "CRE compilation failed. Check the workflow toolchain and source before retrying. No evaluation result was accepted.", 502);
  return new EngineError("CRE_RUN_FAILED", "The CRE workflow could not complete. Check CLI availability, authentication, toolchain and target-chain access. No fallback evaluator was used.", 502);
}

const childEnvNames = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "CRE_API_KEY", "ORCUS_CRE_PROPOSAL_TOKEN"];
export function creChildEnvironment(): NodeJS.ProcessEnv {
  return { NODE_ENV: process.env.NODE_ENV ?? "production", ...Object.fromEntries(childEnvNames.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]])) };
}
const outputSchema = z.object({
  evaluationId: z.string(), automationId: z.string(), accountId: z.string(), chainId: z.number(),
  decision: z.enum(["allow", "reject", "no-action"]), reason: z.string(),
  source: z.literal("local-simulation"), observedAt: z.number(), expiresAt: z.number(),
  controlRevision: z.number().int(), policyVersion: z.number().int(),
  requestId: z.string().optional().transform(value => value || undefined), proposalId: z.string().optional(),
  observations: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export interface CreEvaluationInput {
  evaluationId: string;
  automationId: string;
  account: TradingAccount;
  kind?: "trade" | "alert";
  request?: TradeRequest;
  condition?: { operator: "above" | "below" | "always"; price?: string; maxAgeSeconds?: number; symbol?: string };
  instruction?: string;
  controlRevision: number;
  policyVersion: number;
  expiresAt: number;
  proposal?: TradeRequest;
  requestId?: string;
  proposalUrl?: string;
}

export function parseCreOutput(stdout: string) {
  const clean = stdout.replace(/\u001b\[[0-9;]*m/g, "");
  const marker = "ORCUS_CRE_RESULT=", partMarker = "ORCUS_CRE_RESULT_PART=";
  const all = clean.split(/\r?\n/), lines = all.filter(line => line.includes(marker)), parts = all.filter(line => line.includes(partMarker));
  if (!lines.length && !parts.length) throw new EngineError("CRE_OUTPUT_MISSING", "The CRE workflow returned no authenticated evaluation output.", 502);
  try {
    if (lines.length > 1 || lines.length && parts.length || parts.length > 64) throw new Error("ambiguous result");
    const payload = lines.length ? lines[0].slice(lines[0].indexOf(marker) + marker.length).trim() : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts.map((line, index) => {
      const match = /^([1-9]\d?)\/([1-9]\d?):([A-Za-z0-9+/]+={0,2})$/.exec(line.slice(line.indexOf(partMarker) + partMarker.length));
      if (!match || Number(match[1]) !== index + 1 || Number(match[2]) !== parts.length || match[3].length > 684) throw new Error("incomplete result");
      const bytes = Buffer.from(match[3], "base64");
      if (!bytes.length || bytes.length > 512 || bytes.toString("base64") !== match[3]) throw new Error("invalid result part");
      return bytes;
    })));
    if (Buffer.byteLength(payload, "utf8") > 32_768) throw new Error("oversized result");
    return outputSchema.parse(JSON.parse(payload));
  }
  catch { throw new EngineError("CRE_OUTPUT_INVALID", "The CRE workflow returned malformed or unsupported output.", 502); }
}

export async function strategyObservationConfig(input: CreEvaluationInput) {
  const kind = input.kind ?? "trade", symbol = kind === "alert" ? input.condition!.symbol! : input.request!.symbol;
  if(kind === "trade" && input.condition?.symbol && !automationMarketMatches(input.account.venue,symbol,input.condition.symbol))throw new EngineError("CONDITION_MARKET_MISMATCH","The condition must name the same market as its reviewed trade. Cross-market triggers are not supported.");
  if (input.account.venue === "ostium") {
    assertOstiumAccount(input.account);
    if (input.request?.type === "remove-collateral") throw new EngineError("OWNER_ONLY", "Ostium collateral removal requires the owner's explicit signature, not an unattended strategy.", 403);
    if (input.condition?.symbol && input.condition.symbol !== symbol) throw new EngineError("CONDITION_MARKET_MISMATCH", "The native condition must name the same exact pair as its approved action.");
    const pair = await getOstiumPair(symbol);
    return { chainName: "ethereum-testnet-sepolia-arbitrum-1", tokenAddress: OSTIUM_TESTNET.usdc, tokenDecimals: 6, marketUrl: "https://builder.prod.bedrock.ostium.io/v1/prices", ostium: { pairId: Number(pair.pairId), symbol } };
  }
  const base = symbol.toUpperCase().split(/[\/-]/)[0].replace(/USDC$|USD$/, ""), asset = base === "WETH" ? "ETH" : base;
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) throw new EngineError("UNSUPPORTED_MARKET", "This market cannot be evaluated by the configured external price source.");
  const uni = engineConfig().uniswap;
  const tokenAddress = input.proposal?.tokenIn ?? input.request?.tokenIn ?? (input.request?.side === "sell" ? uni.weth : uni.usdc);
  return { chainName: "ethereum-testnet-sepolia", tokenAddress, tokenDecimals: tokenAddress.toLowerCase() === uni.usdc.toLowerCase() ? 6 : 18, marketUrl: `https://api.coinbase.com/v2/prices/${asset}-USD/spot` };
}

export async function evaluateStrategy(input: CreEvaluationInput) {
  const cfg = engineConfig().cre;
  if (!cfg.enabled) throw new EngineError("CRE_NOT_CONFIGURED", "Conditional automation requires the real CRE runner. Configure and authenticate it before activating this strategy.", 503);
  const kind = input.kind ?? "trade";
  if (kind === "trade" && !input.request) throw new EngineError("MISSING_PROPOSAL", "0G supplied no executable proposal; this evaluation cannot authorize a trade.", 422);
  if (kind === "alert" && (!input.condition?.symbol || !input.condition.price || input.condition.operator === "always")) throw new EngineError("INVALID_ALERT", "A price alert requires an instrument and an explicit above/below threshold.", 422);
  const workflowDir = resolve(requireConfigured(cfg.workflowDir, "CRE_WORKFLOW_DIR"));
  const cliPath = cfg.cliPath.includes("/") ? resolve(cfg.cliPath) : cfg.cliPath;
  if (input.expiresAt <= Date.now() || input.account.controlRevision !== input.controlRevision) throw new EngineError("STALE_EVALUATION", "The strategy evaluation expired or its account control revision changed.");
  const observationConfig = await strategyObservationConfig(input);
  const directory = await mkdtemp(join(tmpdir(), "orcus-cre-"));
  const configPath = join(directory, "evaluation.json");
  const envPath = join(directory, "cli.env");
  const publicEnvPath = join(directory, "cli.public.env");
  try {
    await Promise.all([writeFile(envPath, "", { mode: 0o600 }), writeFile(publicEnvPath, "", { mode: 0o600 })]);
    await writeFile(configPath, JSON.stringify({
      schedule: "0 */5 * * * *", evaluationId: input.evaluationId, automationId: input.automationId,
      accountId: input.account.id, accountAddress: input.account.address, chainId: input.account.chainId,
      ...observationConfig,
      kind, venue: input.account.venue, amount: input.request?.amount, request: input.request,
      proposal: input.proposal, proposalId: input.evaluationId, requestId: input.requestId,
      proposalUrl: input.proposalUrl,
      condition: input.condition ?? { operator: "always", maxAgeSeconds: 60 },
      controlRevision: input.controlRevision, policyVersion: input.policyVersion, expiresAt: input.expiresAt,
    }), { mode: 0o600 });
    let stdout: string;
    try {
      const result = await withCreRunner(workflowDir, input.expiresAt, () => run(cliPath, ["workflow", "simulate", "strategy", "--target", cfg.target, "--config", configPath, "--env", envPath, "--public-env", publicEnvPath, "--non-interactive", "--trigger-index", "0"], { cwd: workflowDir, timeout: 90_000, maxBuffer: 1_000_000, env: creChildEnvironment(), windowsHide: true }));
      stdout = result.stdout;
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw creRunFailure(error);
    }
    const result = parseCreOutput(stdout);
    const conditionSchema=z.object({operator:z.enum(["above","below","always"]),price:z.string().optional(),symbol:z.string().optional(),maxAgeSeconds:z.number().int().min(5).max(120).default(60)}).strict();
    const expectedCondition=conditionSchema.parse(input.condition??{operator:"always",maxAgeSeconds:60});
    const returnedCondition=conditionSchema.safeParse(result.condition);
    if(!returnedCondition.success||JSON.stringify(returnedCondition.data)!==JSON.stringify(expectedCondition))throw new EngineError("CRE_BINDING_MISMATCH","The evaluation does not match the reviewed price condition.",422);
    if ((result.kind ?? "trade") !== kind || result.evaluationId !== input.evaluationId || result.automationId !== input.automationId || result.accountId !== input.account.id || result.chainId !== input.account.chainId || result.controlRevision !== input.controlRevision || result.policyVersion !== input.policyVersion || result.expiresAt !== input.expiresAt || result.expiresAt <= Date.now() || result.observedAt > Date.now() + 5_000 || Date.now() - result.observedAt > 120_000 || (result.requestId || undefined) !== input.requestId) throw new EngineError("CRE_BINDING_MISMATCH", "The evaluation does not match the approved account, policy, request or validity window.", 422);
    return { ...result, id: result.evaluationId, workflowEvidence: { cli: "cre workflow simulate", mode: "local-simulation", hasRealObservations: Boolean(result.observations) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
