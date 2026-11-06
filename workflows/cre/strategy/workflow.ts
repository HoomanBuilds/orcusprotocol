import { ConsensusAggregationByFields, LATEST_BLOCK_NUMBER, blockNumber, bytesToBase64, bytesToHex, consensusIdenticalAggregation, consensusMedianAggregation, cre, encodeCallMsg, median, ok, protoBigIntToBigint, text, type HTTPSendRequester, type Runtime } from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, hexToBytes, parseUnits, zeroAddress } from "viem";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimal = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const requestSchema = z.object({ accountId: z.string(), venue: z.enum(["uniswap", "hyperliquid"]), type: z.string(), symbol: z.string(), side: z.enum(["buy", "sell"]), amount: decimal, nativeInput: z.boolean().optional() }).passthrough().superRefine((request, context) => {
  if (request.nativeInput && (request.venue !== "uniswap" || request.type !== "swap" || request.side !== "sell" || request.symbol.toUpperCase() !== "WETH/USDC")) context.addIssue({ code: "custom", message: "Native ETH input requires a supported spot sell." });
});
export const configSchema = z.object({
  schedule: z.string(), evaluationId: z.string().min(1), automationId: z.string().min(1), accountId: z.string().min(1), accountAddress: address,
  chainId: z.number().int(), chainName: z.literal("ethereum-testnet-sepolia"), tokenAddress: address, tokenDecimals: z.number().int().min(0).max(36),
  kind: z.enum(["trade", "alert"]).default("trade"), venue: z.enum(["uniswap", "hyperliquid"]), amount: decimal.optional(), request: requestSchema.optional(), proposal: requestSchema.optional(), proposalId: z.string(), requestId: z.string().optional(),
  proposalUrl: z.string().url().optional(), marketUrl: z.string().regex(/^https:\/\/api\.coinbase\.com\/v2\/prices\/[A-Z0-9]{2,12}-USD\/spot$/),
  condition: z.object({ operator: z.enum(["above", "below", "always"]), price: decimal.optional(), maxAgeSeconds: z.number().int().min(5).max(120).default(60), symbol: z.string().optional() }),
  controlRevision: z.number().int().min(0), policyVersion: z.number().int().min(1), expiresAt: z.number().int().positive(),
}).strict();
type Config = z.infer<typeof configSchema>;

function readMarket(requester: HTTPSendRequester, url: string, now: number, maxAgeSeconds: number) {
  const response = requester.sendRequest({ url, method: "GET" }).result();
  if (!ok(response) || response.body.length > 64_000) throw new Error("The external price service is unavailable.");
  const dateHeader = Object.entries(response.multiHeaders).sort(([left], [right]) => left.localeCompare(right)).find(([name]) => name.toLowerCase() === "date")?.[1].values[0] ?? Object.entries(response.headers).sort(([left], [right]) => left.localeCompare(right)).find(([name]) => name.toLowerCase() === "date")?.[1];
  const observedAt = Date.parse(dateHeader ?? "");
  const body = JSON.parse(text(response)) as { data?: { amount?: string; currency?: string } };
  const price = Number(body.data?.amount);
  if (!Number.isFinite(price) || price <= 0 || body.data?.currency !== "USD" || !Number.isFinite(observedAt) || observedAt > now + 5_000 || now - observedAt > maxAgeSeconds * 1_000) throw new Error("The external price observation is invalid or stale.");
  return { price, observedAt };
}

function readHyperliquidBalance(requester: HTTPSendRequester, owner: string) {
  const body = bytesToBase64(new TextEncoder().encode(JSON.stringify({ type: "clearinghouseState", user: owner })));
  const response = requester.sendRequest({ url: "https://api.hyperliquid-testnet.xyz/info", method: "POST", headers: { "Content-Type": "application/json" }, body }).result();
  if (!ok(response) || response.body.length > 128_000) throw new Error("Hyperliquid account observation failed.");
  const result = JSON.parse(text(response)) as { withdrawable?: string; marginSummary?: { accountValue?: string } };
  const collateral = Number(result.marginSummary?.accountValue);
  if (!Number.isFinite(collateral) || collateral < 0) throw new Error("The venue returned invalid collateral.");
  return collateral;
}

function retrieveProposal(requester: HTTPSendRequester, url: string, token: string) {
  const response = requester.sendRequest({ url, method: "GET", headers: { Authorization: `Bearer ${token}` } }).result();
  if (!ok(response) || response.body.length > 32_000) throw new Error("The authorized proposal could not be retrieved.");
  return text(response);
}

export function onCron(runtime: Runtime<Config>) {
  const config = runtime.config;
  const now = runtime.now().getTime();
  const observations: Record<string, string | number> = {};
  const finish = (decision: "allow" | "reject" | "no-action", reason: string) => {
    const output = { kind: config.kind, evaluationId: config.evaluationId, automationId: config.automationId, accountId: config.accountId, chainId: config.chainId, decision, reason, source: "local-simulation" as const, observedAt: now, expiresAt: config.expiresAt, controlRevision: config.controlRevision, policyVersion: config.policyVersion, requestId: config.requestId ?? "", proposalId: config.proposalId, observations };
    runtime.log(`ORCUS_CRE_RESULT=${JSON.stringify(output)}`);
    return output;
  };
  if (config.expiresAt <= now) return finish("reject", "The approved evaluation expired.");
  const request = config.request;
  if (config.accountAddress === zeroAddress || (config.kind === "trade" && (!request || request.accountId !== config.accountId || request.venue !== config.venue || request.amount !== config.amount))) return finish("reject", "The request does not match this approved trading account.");
  let proposal = config.proposal;
  const http = new cre.capabilities.HTTPClient();
  if (config.kind === "trade" && config.proposalUrl) {
    const secret = runtime.getSecret({ id: "ORCUS_CRE_PROPOSAL_TOKEN" }).result();
    const raw = http.sendRequest(runtime, retrieveProposal, consensusIdenticalAggregation<string>())(config.proposalUrl, secret.value).result();
    const envelope = JSON.parse(raw) as { evaluationId?: string; requestId?: string; proposal?: unknown };
    if (envelope.evaluationId !== config.evaluationId || envelope.requestId !== config.requestId) return finish("reject", "The proposal is not bound to this evaluation.");
    proposal = requestSchema.parse(envelope.proposal);
  }
  if (config.kind === "trade") {
    if (!proposal || !request) return finish("no-action", "No executable proposal was supplied.");
    for (const key of ["accountId", "venue", "type", "symbol", "side", "amount"] as const) if (proposal[key] !== request[key]) return finish("reject", "The proposal differs from the approved candidate.");
    if ((proposal.nativeInput ?? false) !== (request.nativeInput ?? false)) return finish("reject", "The proposal changes the approved input asset.");
  } else if (config.condition.operator === "always") return finish("reject", "Alerts require an explicit price threshold.");
  const market = http.sendRequest(runtime, readMarket, ConsensusAggregationByFields<{ price: number; observedAt: number }>({ price: median, observedAt: median }))(config.marketUrl, now, config.condition.maxAgeSeconds).result();
  observations.marketPriceUsd = market.price;
  observations.marketObservedAt = market.observedAt;
  observations.marketSource = config.marketUrl;
  if (config.venue === "uniswap") {
    if (config.chainId !== 11155111) return finish("reject", "The spot strategy is not bound to Ethereum Sepolia.");
    const evm = new cre.capabilities.EVMClient(cre.capabilities.EVMClient.SUPPORTED_CHAIN_SELECTORS[config.chainName]);
    const reply = evm.headerByNumber(runtime, { blockNumber: LATEST_BLOCK_NUMBER }).result();
    const header = reply.header;
    if (!header?.blockNumber) return finish("reject", "The target chain returned no block evidence.");
    const block = protoBigIntToBigint(header.blockNumber);
    const blockTime = Number(header.timestamp) * 1000;
    if (blockTime > now + 5_000 || now - blockTime > config.condition.maxAgeSeconds * 1000) return finish("reject", "The target-chain observation is stale.");
    let balance: bigint;
    if (request?.nativeInput) {
      const result = evm.balanceAt(runtime, { account: bytesToBase64(hexToBytes(getAddress(config.accountAddress))), blockNumber: blockNumber(block) }).result();
      if (!result.balance) return finish("reject", "The target chain returned no native ETH balance evidence.");
      balance = protoBigIntToBigint(result.balance);
    } else {
      const result = evm.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to: getAddress(config.tokenAddress), data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(config.accountAddress)] }) }), blockNumber: blockNumber(block) }).result();
      balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: bytesToHex(result.data) });
    }
    observations.blockNumber = block.toString();
    observations.blockObservedAt = blockTime;
    observations.inputBalanceAtoms = balance.toString();
    observations.inputToken = request?.nativeInput ? "ETH" : config.tokenAddress;
    if (config.kind === "trade" && (!config.amount || balance < parseUnits(config.amount, request?.nativeInput ? 18 : config.tokenDecimals))) return finish("reject", "The account lacks the approved input asset balance.");
  } else {
    if (config.chainId !== 421614) return finish("reject", "The perpetual strategy is not bound to Hyperliquid testnet.");
    const collateral = http.sendRequest(runtime, readHyperliquidBalance, consensusMedianAggregation<number>())(config.accountAddress).result();
    observations.venueAccountValueUsd = collateral;
    observations.venueSource = "Hyperliquid testnet clearinghouseState via CRE HTTP";
    if (config.kind === "trade" && collateral === 0 && !["cancel", "close", "reduce"].includes(request?.type ?? "")) return finish("reject", "The venue account has no trading collateral.");
  }
  const threshold = Number(config.condition.price);
  if (config.condition.operator !== "always" && (!Number.isFinite(threshold) || threshold <= 0)) return finish("reject", "The approved condition has no valid threshold.");
  const matches = config.condition.operator === "always" || (config.condition.operator === "above" ? market.price > threshold : market.price < threshold);
  return matches ? finish("allow", config.kind === "alert" ? "The price alert threshold is met. Notify the owner; no trade is authorized by this alert." : "Fresh observations satisfy the approved strategy; the execution worker must recheck current permissions and risk limits.") : finish("no-action", "The approved market condition is not satisfied.");
}

export function initWorkflow(config: Config) {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron)];
}
