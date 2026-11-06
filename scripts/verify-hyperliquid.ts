import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { getAddress, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tradeRequestSchema, type TradingAccount, type TradeRequest } from "@orcus/core";
import { getHyperliquidMarkets, getHyperliquidPortfolio, hyperliquidInfo, prepareHyperliquidAction, reconcileHyperliquidAction, submitHyperliquidAgentAction } from "../agent/src/venues/hyperliquid";
import { atomsToDecimal, decimalToAtoms } from "../agent/src/venues/hyperliquid/wire-format";
import { assertBoundedTestAction, assertEmptyTestAccount, cappedEthSize, positiveFees, verificationArgs, VerificationSafetyError } from "./lib/hyperliquid-testnet";

type Agent = { name: string; address: string; validUntil: number };
type Observation = { label: string; at: number; [key: string]: unknown };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const options = verificationArgs(process.argv.slice(2));
  const account: TradingAccount = { id: "hyperliquid-testnet-verification", userId: "operator-verification", venue: "hyperliquid", chainId: 421614, address: options.owner, ownerAddress: options.owner, status: "connected", controlRevision: 0 };
  const agents = () => hyperliquidInfo<Agent[]>({ type: "extraAgents", user: options.owner });
  const [before, originalAgents, markets, meta, feeSchedule] = await Promise.all([
    getHyperliquidPortfolio(account), agents(), getHyperliquidMarkets(),
    hyperliquidInfo<{ universe: Array<{ name: string }> }>({ type: "meta" }),
    hyperliquidInfo<{ userCrossRate: string }>({ type: "userFees", user: options.owner }),
  ]);
  const market = markets.find(item => item.symbol === "ETH"), assetIndex = meta.universe.findIndex(item => item.name === "ETH");
  if (!market || assetIndex < 0 || market.sizeDecimals === undefined) throw new VerificationSafetyError("ETH testnet metadata is unavailable.");
  const size = cappedEthSize(market.midPrice, market.sizeDecimals, options.maxNotional);
  const projectedFees = decimalToAtoms(options.maxNotional, 18) * decimalToAtoms(feeSchedule.userCrossRate, 18) * 3n / 10n ** 18n;
  const directory = join(process.env.ORCUS_DATA_DIR ?? join(homedir(), ".local", "share", "orcus-ethglobal"), "verification");
  if (!isAbsolute(directory)) throw new VerificationSafetyError("Use an absolute runtime data directory.");
  const evidencePath = join(directory, `hyperliquid-${options.owner.toLowerCase()}.json`);
  const overview = { network: "hyperliquid-testnet", account: options.owner, mode: options.allowTrades ? "capped-writes" : "read-only", maxNotionalMockUsdc: options.maxNotional, maxFeesMockUsdc: options.maxFees, proposedEthSize: size, midPrice: market.midPrice, feeRate: feeSchedule.userCrossRate, before, originalAgents, evidencePath };
  console.log(JSON.stringify(overview, null, 2));
  if (!options.allowTrades) return;

  assertEmptyTestAccount(before, originalAgents);
  if (projectedFees >= decimalToAtoms(options.maxFees, 18)) throw new VerificationSafetyError("The conservative round-trip fee estimate exceeds the approved fee cap.");
  if (existsSync(evidencePath)) {
    const previous = JSON.parse(readFileSync(evidencePath, "utf8")) as { status?: string };
    if (previous.status !== "completed") throw new VerificationSafetyError("An earlier verification is unresolved. Reconcile its recorded orders and fresh agent before another test.");
  }
  const key = process.env.ZEROG_STORAGE_SPONSOR_PRIVATE_KEY;
  if (!key || !/^0x[\da-fA-F]{64}$/.test(key)) throw new VerificationSafetyError("The dedicated testnet owner signer is not configured.");
  const owner = privateKeyToAccount(key as Hex);
  if (getAddress(owner.address) !== options.owner) throw new VerificationSafetyError("The configured signer is not the explicitly approved owner.");
  const agentKey = generatePrivateKey(), agent = privateKeyToAccount(agentKey), agentName = `orcus-${randomBytes(5).toString("hex")}`;
  if (originalAgents.some(item => item.name === agentName)) throw new VerificationSafetyError("The fresh agent name collided with an existing agent.");
  account.agentAddress = agent.address; account.status = "authorized";
  const ownerExchange = new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet: owner, signatureChainId: "0x66eee" });
  const observations: Observation[] = [], knownOrderIds = new Set<number>(), createdOrders: Array<{ cloid: Hex; expiresAt: number }> = [];
  let status = "running", approvalAttempted = false, opened = false, failure: unknown;
  const save = (label: string, fields: Record<string, unknown> = {}) => {
    observations.push({ label, at: Date.now(), ...fields });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(evidencePath, JSON.stringify({ ...overview, freshAgent: { name: agentName, address: agent.address }, status, observations }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ label, ...fields }));
  };
  const feeEvidence = async () => {
    const fills = await hyperliquidInfo<unknown>({ type: "userFillsByTime", user: options.owner, startTime: observations[0]?.at ?? Date.now(), endTime: Date.now(), aggregateByTime: false });
    const total = positiveFees(fills, knownOrderIds);
    if (decimalToAtoms(total, 18) > decimalToAtoms(options.maxFees, 18)) throw new VerificationSafetyError("Observed fees exceeded the approved cap. Stop all opening actions and inspect cleanup.");
    return { totalFeesMockUsdc: total, fills };
  };
  const assertAgentsPreserved = async () => {
    const current = await agents();
    for (const original of originalAgents) if (!current.some(item => item.name === original.name && getAddress(item.address) === getAddress(original.address) && item.validUntil === original.validUntil)) throw new VerificationSafetyError("An existing agent changed unexpectedly; stop and inspect the account.");
    return current;
  };
  const assertPositionBound = async () => {
    const portfolio = await getHyperliquidPortfolio(account);
    if (portfolio.positions.some(position => position.symbol !== "ETH" || position.side !== "long" || decimalToAtoms(position.size, 18) > decimalToAtoms(size, 18))) throw new VerificationSafetyError("Unexpected exposure appeared. It will not be changed by this test.");
    return portfolio;
  };
  async function action(label: string, actor: "owner" | "agent", input: Partial<TradeRequest>, opening = false) {
    if (opening && opened) throw new VerificationSafetyError("Only one opening order is authorized.");
    const request = tradeRequestSchema.parse({ accountId: account.id, venue: "hyperliquid", type: "close", symbol: "ETH", side: "sell", amount: size, slippageBps: 50, mode: actor === "owner" ? "manual" : "agent", ...input });
    const prepared = await prepareHyperliquidAction(request, account);
    prepared.expiresAt = Math.min(prepared.expiresAt, Date.now() + 20_000);
    if (prepared.hyperliquid?.method === "order") {
      assertBoundedTestAction(prepared, { owner: options.owner, assetIndex, maxSize: size, maxNotional: options.maxNotional, opening });
      const order = (prepared.hyperliquid.params.orders as Array<{ c: Hex }>)[0];
      createdOrders.push({ cloid: order.c, expiresAt: prepared.expiresAt });
    } else if (prepared.hyperliquid?.method !== "cancel" || !request.orderId || !knownOrderIds.has(Number(request.orderId))) throw new VerificationSafetyError("Only cancellation of this run's own order is authorized.");
    await assertPositionBound(); await assertAgentsPreserved(); await feeEvidence();
    save(`${label}:intent`, { actor, clientOrderId: createdOrders.at(-1)?.cloid, requestType: request.type });
    if (opening) opened = true;
    let orderId: string | undefined, uncertain = false;
    try {
      if (actor === "agent") {
        const result = await submitHyperliquidAgentAction(prepared, account, agentKey, { assertAuthority: async () => { await assertAgentsPreserved(); } });
        orderId = result.orderId; uncertain = result.status === "submitted-unknown";
        if (result.status === "rejected") throw new VerificationSafetyError("The venue rejected the bounded agent order.");
      } else {
        const operation = prepared.hyperliquid!;
        const response = operation.method === "order" ? await ownerExchange.order(operation.params as Parameters<typeof ownerExchange.order>[0], { expiresAfter: prepared.expiresAt }) : await ownerExchange.cancel(operation.params as Parameters<typeof ownerExchange.cancel>[0], { expiresAfter: prepared.expiresAt });
        const state = (response as { response?: { data?: { statuses?: Array<{ error?: string; resting?: { oid: number }; filled?: { oid: number } } | string> } } }).response?.data?.statuses?.[0];
        if (state && typeof state === "object") { if (state.error) throw new VerificationSafetyError("The venue rejected the bounded owner order."); orderId = String(state.resting?.oid ?? state.filled?.oid ?? "") || undefined; }
      }
    } catch (error) {
      if (error instanceof VerificationSafetyError) throw error;
      uncertain = true;
    }
    if (orderId) knownOrderIds.add(Number(orderId));
    let evidence = await reconcileHyperliquidAction({ orderId, prepared }, account);
    for (let attempt = 0; attempt < 5 && evidence.status === "submitted-unknown"; attempt++) { await sleep(500); evidence = await reconcileHyperliquidAction({ orderId, prepared }, account); }
    if (evidence.orderId) knownOrderIds.add(Number(evidence.orderId));
    save(label, { actor, ...evidence, transportWasUncertain: uncertain });
    if (evidence.status === "submitted-unknown" || evidence.status === "rejected") throw new VerificationSafetyError("The order result remains unresolved or rejected. No opening request will be retried.");
    return { prepared, ...evidence };
  }
  try {
    save("approval:intent", { agentName, agentAddress: agent.address }); approvalAttempted = true;
    await ownerExchange.approveAgent({ agentAddress: agent.address, agentName: `${agentName} valid_until ${Date.now() + 600_000}` });
    if (!(await assertAgentsPreserved()).some(item => getAddress(item.address) === agent.address && item.name === agentName)) throw new VerificationSafetyError("Fresh agent approval was not observed.");
    save("approval:observed", { agentName, agentAddress: agent.address });
    const openedAction = await action("owner-opens-eth", "owner", { type: "market", side: "buy", reduceOnly: false }, true);
    if (openedAction.status !== "confirmed") throw new VerificationSafetyError("The opening IOC did not fully reconcile; only cleanup is allowed.");
    const position = (await assertPositionBound()).positions.find(item => item.symbol === "ETH");
    if (!position) throw new VerificationSafetyError("The opened position was not observed.");
    const mid = decimalToAtoms((await getHyperliquidMarkets()).find(item => item.symbol === "ETH")!.midPrice, 18);
    const stop = await action("agent-adds-stop", "agent", { type: "stop-loss", amount: position.size, triggerPrice: atomsToDecimal(mid / 2n, 18) });
    if (!stop.orderId || stop.status !== "pending") throw new VerificationSafetyError("The protective stop did not remain open as expected.");
    await action("owner-cancels-agent-stop", "owner", { type: "cancel", orderId: stop.orderId });
    const takeProfit = await action("agent-adds-take-profit", "agent", { type: "take-profit", amount: position.size, triggerPrice: atomsToDecimal(mid * 2n, 18) });
    if (!takeProfit.orderId || takeProfit.status !== "pending") throw new VerificationSafetyError("The protective take-profit did not remain open as expected.");
    await action("agent-cancels-take-profit", "agent", { type: "cancel", orderId: takeProfit.orderId });
    await action("agent-closes-owner-position", "agent", { type: "close" });
    if ((await assertPositionBound()).positions.length) throw new VerificationSafetyError("Residual exposure remains; owner cleanup is required.");
  } catch (error) { failure = error; save("verification:stopped", { message: error instanceof VerificationSafetyError ? error.message : "The venue response could not be verified. Inspect cleanup evidence before retrying." }); }
  finally {
    try {
      const latestExpiry = Math.max(0, ...createdOrders.map(item => item.expiresAt));
      if (failure && latestExpiry > Date.now()) { save("cleanup:awaiting-order-expiry"); await sleep(latestExpiry - Date.now() + 500); }
      for (const order of createdOrders) {
        const state = await hyperliquidInfo<{ status: string; order?: { status: string; order: { oid: number } } }>({ type: "orderStatus", user: options.owner, oid: order.cloid });
        if (state.status === "order" && state.order) {
          knownOrderIds.add(state.order.order.oid);
          if (state.order.status === "open" || state.order.status === "triggered") { save("cleanup-cancel:intent", { clientOrderId: order.cloid }); await ownerExchange.cancelByCloid({ cancels: [{ asset: assetIndex, cloid: order.cloid }] }, { expiresAfter: Date.now() + 20_000 }); }
        }
      }
      const residual = await assertPositionBound();
      if (residual.positions.length) await action("owner-closes-residue", "owner", { type: "close" });
      const after = await getHyperliquidPortfolio(account), fees = await feeEvidence();
      if (after.positions.length || after.orders.length) throw new VerificationSafetyError("Cleanup is unresolved; do not run another verification.");
      save("cleanup:flat", { after, ...fees });
    } catch { failure ??= new VerificationSafetyError("Owner cleanup could not be confirmed. Inspect recorded client order IDs and account state."); save("cleanup:unresolved"); }
    if (approvalAttempted) {
      try {
        const current = await assertAgentsPreserved();
        if (current.some(item => item.name === agentName && getAddress(item.address) === agent.address)) { save("revoke:intent", { agentName }); await ownerExchange.approveAgent({ agentAddress: zeroAddress, agentName }); }
        if ((await assertAgentsPreserved()).some(item => item.name === agentName && getAddress(item.address) === agent.address)) throw new VerificationSafetyError("Fresh agent revocation is unresolved.");
        save("revoke:observed", { agentName });
      } catch { failure ??= new VerificationSafetyError("Fresh agent revocation could not be confirmed. Revoke only the recorded Orcus verification agent."); save("revoke:unresolved", { agentName, agentAddress: agent.address }); }
    }
    status = failure ? "unresolved" : "completed";
    save("verification:finished", { status, publicMainnetWrites: 0, openingRequests: opened ? 1 : 0, notProven: ["browser extension signing UI", "mainnet execution", "permission scope enforced natively by Hyperliquid"] });
  }
  if (failure) throw failure;
}

main().catch(error => { console.error(error instanceof VerificationSafetyError ? error.message : "Hyperliquid verification stopped. Inspect its public evidence and account state before retrying."); process.exitCode = 1; });
