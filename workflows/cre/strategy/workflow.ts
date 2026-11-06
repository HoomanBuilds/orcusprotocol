import { ConsensusAggregationByFields, LATEST_BLOCK_NUMBER, blockNumber, bytesToBase64, bytesToHex, consensusIdenticalAggregation, consensusMedianAggregation, cre, encodeCallMsg, getNetwork, identical, median, ok, protoBigIntToBigint, text, type HTTPSendRequester, type Runtime } from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, hexToBytes, zeroAddress } from "viem";
import { z } from "zod";
import { tradeRequestSchema } from "../../../packages/core/src/index";
import { decimalAtoms, decimalString, parsePositiveDecimalE8, sameRequest } from "./values";
import { OSTIUM_TESTNET } from "../../../packages/wallets/src/ostium-deployment";
import { ostiumPricesUrl, readOstiumMarket, type OstiumObservation } from "./ostium";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimal = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const schedule = z.string().regex(/^\S+(?:\s+\S+){5}$/);
const coinbaseUrl = z.string().regex(/^https:\/\/api\.coinbase\.com\/v2\/prices\/[A-Z0-9]{2,12}-USD\/spot$/);
const marketUrl = z.union([coinbaseUrl, z.literal(ostiumPricesUrl)]);
const requestSchema = tradeRequestSchema;
const strategyConfigSchema = z.object({
  mode: z.literal("strategy").default("strategy"),
  schedule, evaluationId: z.string().min(1), automationId: z.string().min(1), accountId: z.string().min(1), accountAddress: address,
  chainId: z.number().int(), chainName: z.enum(["ethereum-testnet-sepolia", "ethereum-testnet-sepolia-arbitrum-1"]), tokenAddress: address, tokenDecimals: z.number().int().min(0).max(36),
  kind: z.enum(["trade", "alert"]).default("trade"), venue: z.enum(["uniswap", "hyperliquid", "ostium"]), amount: decimal.optional(), request: requestSchema.optional(), proposal: requestSchema.optional(), proposalId: z.string(), requestId: z.string().optional(),
  ostium: z.object({ pairId: z.number().int().min(0).max(65535), symbol: z.string().max(50).regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/) }).strict().optional(),
  proposalUrl: z.string().max(2048).regex(/^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?(?:\/[A-Za-z0-9_~.!$&'()*+,;=:@%/?-]*)?$/).optional(), marketUrl,
  condition: z.object({ operator: z.enum(["above", "below", "always"]), price: decimal.optional(), maxAgeSeconds: z.number().int().min(5).max(120).default(60), symbol: z.string().optional() }),
  controlRevision: z.number().int().min(0), policyVersion: z.number().int().min(1), expiresAt: z.number().int().positive(),
}).strict();
export const configSchema = z.union([strategyConfigSchema, z.object({ mode: z.literal("local-simulation"), schedule, marketUrl: coinbaseUrl, samplePreviousPrice: decimal }).strict()]);
type Config = z.infer<typeof configSchema>;

function readMarket(requester: HTTPSendRequester, url: string, now: number, maxAgeSeconds: number) {
  const response = requester.sendRequest({ url, method: "GET" }).result();
  if (!ok(response) || response.body.length > 64_000) throw new Error("The external price service is unavailable.");
  const dateHeader = Object.entries(response.multiHeaders).sort(([left], [right]) => left.localeCompare(right)).find(([name]) => name.toLowerCase() === "date")?.[1].values[0] ?? Object.entries(response.headers).sort(([left], [right]) => left.localeCompare(right)).find(([name]) => name.toLowerCase() === "date")?.[1];
  const observedAt = Date.parse(dateHeader ?? "");
  const body = JSON.parse(text(response)) as { data?: { amount?: string; currency?: string } };
  if (typeof body.data?.amount !== "string" || body.data?.currency !== "USD" || !Number.isFinite(observedAt) || observedAt > now + 5_000 || now - observedAt > maxAgeSeconds * 1_000) throw new Error("The external price observation is invalid or stale.");
  const price = parsePositiveDecimalE8(body.data.amount);
  return { price, observedAt };
}

function readHyperliquidBalance(requester: HTTPSendRequester, owner: string) {
  const body = bytesToBase64(new TextEncoder().encode(JSON.stringify({ type: "clearinghouseState", user: owner })));
  const response = requester.sendRequest({ url: "https://api.hyperliquid-testnet.xyz/info", method: "POST", headers: { "Content-Type": "application/json" }, body }).result();
  if (!ok(response) || response.body.length > 128_000) throw new Error("Hyperliquid account observation failed.");
  const result = JSON.parse(text(response)) as { withdrawable?: string; marginSummary?: { accountValue?: string } };
  if (typeof result.marginSummary?.accountValue !== "string") throw new Error("The venue returned invalid collateral.");
  return decimalAtoms(result.marginSummary.accountValue, 6, true);
}

function retrieveProposal(requester: HTTPSendRequester, url: string, token: string) {
  const response = requester.sendRequest({ url, method: "GET", headers: { Authorization: `Bearer ${token}` } }).result();
  if (!ok(response) || response.body.length > 32_000) throw new Error("The authorized proposal could not be retrieved.");
  return text(response);
}

export function onCron(runtime: Runtime<Config>): string {
  const config = runtime.config;
  const now = runtime.now().getTime();
  if (config.mode === "local-simulation") {
    const market = new cre.capabilities.HTTPClient().sendRequest(runtime, readMarket, ConsensusAggregationByFields<{ price: bigint; observedAt: number }>({ price: median, observedAt: median }))(config.marketUrl, now, 120).result();
    const previous = parsePositiveDecimalE8(config.samplePreviousPrice);
    const output = { mode: "local-simulation", currentPrice: decimalString(market.price, 8), previousPrice: decimalString(previous, 8), changed: market.price !== previous, wouldWrite: false };
    runtime.log(`ORCUS_CRE_LOCAL_RESULT=${JSON.stringify(output)}`);
    return JSON.stringify(output);
  }
  const observations: Record<string, string | number> = {};
  const finish = (decision: "allow" | "reject" | "no-action", reason: string) => {
    const output = { kind: config.kind, evaluationId: config.evaluationId, automationId: config.automationId, accountId: config.accountId, chainId: config.chainId, decision, reason, source: "local-simulation" as const, observedAt: now, expiresAt: config.expiresAt, controlRevision: config.controlRevision, policyVersion: config.policyVersion, requestId: config.requestId ?? "", proposalId: config.proposalId, condition: config.condition, observations };
    const serialized = JSON.stringify(output), bytes = new TextEncoder().encode(serialized), count = Math.ceil(bytes.length / 512);
    if (count > 64) throw new Error("The evaluation evidence exceeds its bounded result size.");
    for (let index = 0; index < count; index++) runtime.log(`ORCUS_CRE_RESULT_PART=${index + 1}/${count}:${bytesToBase64(bytes.slice(index * 512, (index + 1) * 512))}`);
    return serialized;
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
    const market = (value: string) => { const base = value.toUpperCase().split(/[\/-]/)[0].replace(/USDC$|USD$/, ""); return base === "WETH" ? "ETH" : base; };
    if (config.venue !== "ostium" && config.condition.symbol && market(config.condition.symbol) !== market(request.symbol)) return finish("reject", "The condition names a different market than the approved trade.");
    if ((proposal.nativeInput ?? false) !== (request.nativeInput ?? false)) return finish("reject", "The proposal changes the approved input asset.");
    if (!sameRequest(proposal, request)) return finish("reject", "The proposal differs from the approved candidate.");
  } else if (config.condition.operator === "always") return finish("reject", "Alerts require an explicit price threshold.");
  const native = config.venue === "ostium";
  if (native) {
    if (config.chainId !== OSTIUM_TESTNET.chainId || config.chainName !== "ethereum-testnet-sepolia-arbitrum-1" || getAddress(config.tokenAddress) !== getAddress(OSTIUM_TESTNET.usdc) || config.tokenDecimals !== 6 || config.marketUrl !== ostiumPricesUrl || !config.ostium || config.ostium.symbol !== (config.kind === "alert" ? config.condition.symbol : request?.symbol) || config.condition.symbol && config.condition.symbol !== config.ostium.symbol) return finish("reject", "The native strategy is not bound to its Arbitrum Sepolia pair and collateral.");
    if (request?.type === "remove-collateral") return finish("reject", "Native collateral removal requires the owner's explicit signature, not an automation.");
  } else if (config.marketUrl === ostiumPricesUrl || config.ostium) return finish("reject", "The market observation source belongs to a different venue.");
  const pendingMarket = native ? http.sendRequest(runtime, readOstiumMarket, ConsensusAggregationByFields<OstiumObservation>({ price: median, observedAt: median, pairId: identical, symbol: identical, quoteAsset: identical, feedId: identical, marketOpen: identical, dayTradingClosed: identical, maxLeverage: identical, minLeverage: identical, overnightMaxLeverage: identical, oracleFee: identical }))(config.ostium!.pairId, config.ostium!.symbol, now, config.condition.maxAgeSeconds) : http.sendRequest(runtime, readMarket, ConsensusAggregationByFields<{ price: bigint; observedAt: number }>({ price: median, observedAt: median }))(config.marketUrl, now, config.condition.maxAgeSeconds);
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainName });
  if (config.venue === "uniswap" && (!network || config.chainId !== 11155111)) return finish("reject", "The spot strategy is not bound to Ethereum Sepolia.");
  if (native && !network) return finish("reject", "Arbitrum Sepolia is unavailable to this workflow.");
  const evm = config.venue === "uniswap" || native ? new cre.capabilities.EVMClient(network!.chainSelector.selector) : undefined;
  const pendingHeader = evm?.headerByNumber(runtime, { blockNumber: LATEST_BLOCK_NUMBER });
  const pendingCollateral = config.venue === "hyperliquid" ? http.sendRequest(runtime, readHyperliquidBalance, consensusMedianAggregation<bigint>())(config.accountAddress) : undefined;
  const market = pendingMarket.result();
  const decimals = native ? 18 : 8, quoteAsset = native ? (market as OstiumObservation).quoteAsset : "USD";
  observations.marketPrice = decimalString(market.price, decimals);
  observations.marketQuoteAsset = quoteAsset;
  if (quoteAsset === "USD") observations.marketPriceUsd = observations.marketPrice;
  observations[native ? "marketPriceE18" : "marketPriceE8"] = market.price.toString();
  observations.marketObservedAt = market.observedAt;
  observations.marketSource = config.marketUrl;
  if (config.venue === "uniswap" || native) {
    const reply = pendingHeader!.result();
    const header = reply.header;
    if (!header?.blockNumber) return finish("reject", "The target chain returned no block evidence.");
    const block = protoBigIntToBigint(header.blockNumber);
    const blockTime = Number(header.timestamp) * 1000;
    if (blockTime > now + 5_000 || now - blockTime > config.condition.maxAgeSeconds * 1000) return finish("reject", "The target-chain observation is stale.");
    let balance: bigint;
    if (request?.nativeInput) {
      const result = evm!.balanceAt(runtime, { account: bytesToBase64(hexToBytes(getAddress(config.accountAddress))), blockNumber: blockNumber(block) }).result();
      if (!result.balance) return finish("reject", "The target chain returned no native ETH balance evidence.");
      balance = protoBigIntToBigint(result.balance);
    } else {
      const result = evm!.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to: getAddress(config.tokenAddress), data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(config.accountAddress)] }) }), blockNumber: blockNumber(block) }).result();
      balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: bytesToHex(result.data) });
    }
    observations.blockNumber = block.toString();
    observations.blockObservedAt = blockTime;
    observations.inputBalanceAtoms = balance.toString();
    observations.inputToken = request?.nativeInput ? "ETH" : config.tokenAddress;
    if (native) {
      const tick = market as OstiumObservation, opening = ["market", "limit", "stop"].includes(request?.type ?? "");
      Object.assign(observations, { pairId: tick.pairId, symbol: tick.symbol, feedId: tick.feedId, marketOpen: String(tick.marketOpen), dayTradingClosed: String(tick.dayTradingClosed), collateralBalanceUsdc: decimalString(balance, 6), oracleFeeUsdc: decimalString(tick.oracleFee, 6), venueSource: "Ostium Arbitrum Sepolia USDC balance via CRE EVM" });
      if (config.kind === "trade" && request) {
        if (opening && (!tick.marketOpen || tick.maxLeverage === 0n || request.isDayTrade && tick.dayTradingClosed)) return finish("reject", "The native market is not accepting this entry.");
        if (opening) {
          const leverage = decimalAtoms(String(request.leverage ?? 1), 2);
          if (leverage < tick.minLeverage || leverage > tick.maxLeverage || tick.overnightMaxLeverage > 0n && leverage > tick.overnightMaxLeverage && !request.isDayTrade) return finish("reject", "The native candidate exceeds its current leverage or overnight limits.");
        }
        const debit = opening || request.type === "add-collateral" ? decimalAtoms(request.amount, 6) : ["close", "reduce"].includes(request.type) ? tick.oracleFee : 0n;
        observations.requiredUsdcDebitAtoms = debit.toString();
        if (balance < debit) return finish("reject", "The owner lacks native testnet USDC for this action's collateral or oracle fee.");
      }
    } else if (config.kind === "trade" && (!config.amount || balance < decimalAtoms(config.amount, request?.nativeInput ? 18 : config.tokenDecimals))) return finish("reject", "The account lacks the approved input asset balance.");
  } else {
    if (config.chainId !== 421614) return finish("reject", "The perpetual strategy is not bound to Hyperliquid testnet.");
    const collateral = pendingCollateral!.result();
    observations.venueAccountValueUsd = decimalString(collateral, 6);
    observations.venueSource = "Hyperliquid testnet clearinghouseState via CRE HTTP";
    if (config.kind === "trade" && collateral === 0n && !["cancel", "close", "reduce"].includes(request?.type ?? "")) return finish("reject", "The venue account has no trading collateral.");
  }
  let threshold = 0n;
  if (config.condition.operator !== "always") {
    try { threshold = decimalAtoms(config.condition.price ?? "", decimals); }
    catch { return finish("reject", "The approved condition has no valid threshold."); }
  }
  const matches = config.condition.operator === "always" || (config.condition.operator === "above" ? market.price > threshold : market.price < threshold);
  return matches ? finish("allow", config.kind === "alert" ? "The price alert threshold is met. Notify the owner; no trade is authorized by this alert." : "Fresh observations satisfy the approved strategy; the execution worker must recheck current permissions and risk limits.") : finish("no-action", "The approved market condition is not satisfied.");
}

export function initWorkflow(config: Config) {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron)];
}
