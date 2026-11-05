import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type TradeRequest, type TradingAccount } from "@orcus/core";
import { engineConfig } from "../config";
import { EngineError, requireConfigured } from "../errors";

const run = promisify(execFile);
const childEnvNames = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "CRE_API_KEY", "ORCUS_CRE_PROPOSAL_TOKEN"];
export function creChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(childEnvNames.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
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
  request: TradeRequest;
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
  const marker = "ORCUS_CRE_RESULT=";
  const lines = clean.split(/\r?\n/).filter(line => line.includes(marker));
  if (!lines.length) throw new EngineError("CRE_OUTPUT_MISSING", "The CRE workflow returned no authenticated evaluation output.", 502);
  const payload = lines[lines.length - 1].slice(lines[lines.length - 1].indexOf(marker) + marker.length).trim();
  try { return outputSchema.parse(JSON.parse(payload)); }
  catch { throw new EngineError("CRE_OUTPUT_INVALID", "The CRE workflow returned malformed or unsupported output.", 502); }
}

export async function evaluateStrategy(input: CreEvaluationInput) {
  const cfg = engineConfig().cre;
  if (!cfg.enabled) throw new EngineError("CRE_NOT_CONFIGURED", "Conditional automation requires the real CRE runner. Configure and authenticate it before activating this strategy.", 503);
  if (!input.request) throw new EngineError("MISSING_PROPOSAL", "0G supplied no executable proposal; this evaluation cannot authorize a trade.", 422);
  const workflowDir = resolve(requireConfigured(cfg.workflowDir, "CRE_WORKFLOW_DIR"));
  const cliPath = cfg.cliPath.includes("/") ? resolve(cfg.cliPath) : cfg.cliPath;
  if (input.expiresAt <= Date.now() || input.account.controlRevision !== input.controlRevision) throw new EngineError("STALE_EVALUATION", "The strategy evaluation expired or its account control revision changed.");
  const base = input.request.symbol.toUpperCase().split(/[\/-]/)[0].replace(/USDC$|USD$/, "");
  const asset = base === "WETH" ? "ETH" : base;
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) throw new EngineError("UNSUPPORTED_MARKET", "This market cannot be evaluated by the configured external price source.");
  const uni = engineConfig().uniswap;
  const tokenAddress = input.proposal?.tokenIn ?? input.request.tokenIn ?? (input.request.side === "buy" ? uni.usdc : uni.weth);
  const tokenDecimals = tokenAddress.toLowerCase() === uni.usdc.toLowerCase() ? 6 : 18;
  const directory = await mkdtemp(join(tmpdir(), "orcus-cre-"));
  const configPath = join(directory, "evaluation.json");
  const envPath = join(directory, "cli.env");
  const publicEnvPath = join(directory, "cli.public.env");
  try {
    await Promise.all([writeFile(envPath, "", { mode: 0o600 }), writeFile(publicEnvPath, "", { mode: 0o600 })]);
    await writeFile(configPath, JSON.stringify({
      schedule: "0 */5 * * * *", evaluationId: input.evaluationId, automationId: input.automationId,
      accountId: input.account.id, accountAddress: input.account.address, chainId: input.account.chainId,
      chainName: "ethereum-testnet-sepolia", tokenAddress, tokenDecimals,
      venue: input.request.venue, amount: input.request.amount, request: input.request,
      proposal: input.proposal, proposalId: input.evaluationId, requestId: input.requestId,
      proposalUrl: input.proposalUrl, marketUrl: `https://api.coinbase.com/v2/prices/${asset}-USD/spot`,
      condition: input.condition ?? { operator: "always", maxAgeSeconds: 60 },
      controlRevision: input.controlRevision, policyVersion: input.policyVersion, expiresAt: input.expiresAt,
    }), { mode: 0o600 });
    let stdout: string;
    try {
      const result = await run(cliPath, ["workflow", "simulate", "strategy", "--target", cfg.target, "--config", configPath, "--env", envPath, "--public-env", publicEnvPath, "--non-interactive", "--trigger-index", "0"], { cwd: workflowDir, timeout: 90_000, maxBuffer: 1_000_000, env: creChildEnvironment(), windowsHide: true });
      stdout = result.stdout;
    } catch (error) {
      const text = `${(error as { stderr?: string }).stderr ?? ""} ${(error as { stdout?: string }).stdout ?? ""}`;
      if (/not logged in|authentication required|CRE_API_KEY/i.test(text)) throw new EngineError("CRE_AUTH_REQUIRED", "The CRE CLI requires login or CRE_API_KEY. No strategy trade was authorized.", 503);
      throw new EngineError("CRE_RUN_FAILED", "The CRE workflow could not complete. Check CLI availability, authentication, toolchain and target-chain access. No fallback evaluator was used.", 502);
    }
    const result = parseCreOutput(stdout);
    if (result.evaluationId !== input.evaluationId || result.automationId !== input.automationId || result.accountId !== input.account.id || result.chainId !== input.account.chainId || result.controlRevision !== input.controlRevision || result.policyVersion !== input.policyVersion || result.expiresAt !== input.expiresAt || result.expiresAt <= Date.now() || result.observedAt > Date.now() + 5_000 || Date.now() - result.observedAt > 120_000 || (result.requestId || undefined) !== input.requestId) throw new EngineError("CRE_BINDING_MISMATCH", "The evaluation does not match the approved account, policy, request or validity window.", 422);
    return { ...result, id: result.evaluationId, workflowEvidence: { cli: "cre workflow simulate", mode: "local-simulation", hasRealObservations: Boolean(result.observations) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
