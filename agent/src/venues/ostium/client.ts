import { OstiumClient } from "@ostium/builder-sdk";
import { createPublicClient, getAddress, http, isAddressEqual, parseAbi, stringToHex, type Address } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { OSTIUM_TESTNET, ostiumTradingAbi } from "@orcus/wallets/ostium";
import { EngineError } from "../../errors";

export type OstiumPair = Awaited<ReturnType<OstiumClient["getPairs"]>>["pairs"][number];
export type OstiumPosition = Awaited<ReturnType<OstiumClient["getOpenPositions"]>>["pairPositions"][number]["position"];
export type OstiumOrder = Awaited<ReturnType<OstiumClient["getOpenOrders"]>>[number];
export type OstiumBuiltTx = ReturnType<OstiumClient["getOpenTradeTx"]>;
export const ostiumRpcUrl = () => process.env.OSTIUM_RPC_URL?.trim() || "https://sepolia-rollup.arbitrum.io/rpc";
export const ostiumRpc = () => createPublicClient({ chain: arbitrumSepolia, transport: http(ostiumRpcUrl(), { timeout: 10_000, retryCount: 0 }) });
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
let active = 0;

export async function boundedOstiumRead<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 8) throw new EngineError("OSTIUM_BUSY", "Ostium reads are busy. Refresh in a moment.", 503);
  active++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(work).finally(() => { active--; });
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EngineError("OSTIUM_UNAVAILABLE", "Ostium did not respond in time. Check existing activity before retrying.", 503)), 15_000); timer.unref(); })]);
  } catch (error) { throw error instanceof EngineError ? error : new EngineError("OSTIUM_UNAVAILABLE", "The native venue read failed. Refresh its actual state before retrying.", 503); }
  finally { if (timer) clearTimeout(timer); }
}

export async function verifiedOstiumRpc() {
  try {
  const rpc = ostiumRpc();
  if (await rpc.getChainId() !== OSTIUM_TESTNET.chainId) throw new EngineError("WRONG_NETWORK", "Ostium is restricted to Arbitrum Sepolia.");
  const implementation = await rpc.getStorageAt({ address: OSTIUM_TESTNET.trading, slot: implementationSlot });
  if (!implementation || !isAddressEqual(getAddress(`0x${implementation.slice(-40)}`), OSTIUM_TESTNET.implementation)) throw new EngineError("OSTIUM_IMPLEMENTATION_UNREVIEWED", "Ostium's testnet implementation changed. Trading is paused until its authority is reviewed.", 503);
  const registry = await rpc.readContract({ address: OSTIUM_TESTNET.trading, abi: ostiumTradingAbi, functionName: "registry" });
  if (!isAddressEqual(registry, OSTIUM_TESTNET.registry)) throw new EngineError("OSTIUM_DEPLOYMENT_CHANGED", "Ostium's testnet registry changed. Review the integration before trading.", 503);
  const registryAbi = parseAbi(["function getContractAddress(bytes32) view returns (address)"]);
  const [storage, callbacks, storageImplementation, callbacksImplementation] = await Promise.all([
    rpc.readContract({ address: registry, abi: registryAbi, functionName: "getContractAddress", args: [stringToHex("tradingStorage", { size: 32 })] }),
    rpc.readContract({ address: registry, abi: registryAbi, functionName: "getContractAddress", args: [stringToHex("callbacks", { size: 32 })] }),
    rpc.getStorageAt({ address: OSTIUM_TESTNET.storage, slot: implementationSlot }),
    rpc.getStorageAt({ address: OSTIUM_TESTNET.callbacks, slot: implementationSlot }),
  ]);
  const matches = (value: string | undefined, expected: Address) => value !== undefined && isAddressEqual(getAddress(`0x${value.slice(-40)}`), expected);
  if (!isAddressEqual(storage, OSTIUM_TESTNET.storage) || !isAddressEqual(callbacks, OSTIUM_TESTNET.callbacks) || !matches(storageImplementation, OSTIUM_TESTNET.storageImplementation) || !matches(callbacksImplementation, OSTIUM_TESTNET.callbacksImplementation)) throw new EngineError("OSTIUM_DEPLOYMENT_CHANGED", "Ostium's collateral or payout implementation changed. Review the integration before trading.", 503);
  return rpc;
  } catch (error) { throw error instanceof EngineError ? error : new EngineError("OSTIUM_RPC_UNAVAILABLE", "The native testnet deployment could not be verified. Nothing was signed.", 503); }
}

export async function ostiumSdk(trader?: string, delegate?: string) {
  try {
  const shared = { testnet: true, rpcUrl: ostiumRpcUrl(), subgraphUrl: "https://builder.prod.bedrock.ostium.io/v1/subgraph/gn?chainId=421614", builderApiUrl: "https://builder.prod.bedrock.ostium.io" };
  if (!trader) return await OstiumClient.createReadOnly(shared);
  if (delegate) return await OstiumClient.createDelegatedAndSelf({ ...shared, traderAddress: getAddress(trader), delegateAddress: getAddress(delegate) });
  return await OstiumClient.createSelfAndSelf({ ...shared, traderAddress: getAddress(trader) });
  } catch { throw new EngineError("OSTIUM_SDK_UNAVAILABLE", "The native testnet client could not be initialized safely.", 503); }
}

export async function getOstiumAuthorization(input: { trader: string; chainId: number }) {
  try {
  if (input.chainId !== OSTIUM_TESTNET.chainId) throw new EngineError("WRONG_NETWORK", "Ostium authorization requires Arbitrum Sepolia.");
  const trader = getAddress(input.trader), rpc = await verifiedOstiumRpc();
  const [delegate, blockNumber] = await Promise.all([rpc.readContract({ address: OSTIUM_TESTNET.trading, abi: ostiumTradingAbi, functionName: "delegations", args: [trader] }), rpc.getBlockNumber()]);
  return { trader, delegate, chainId: 421614 as const, contractAddress: OSTIUM_TESTNET.trading, implementation: OSTIUM_TESTNET.implementation, observedAt: Date.now(), blockNumber: blockNumber.toString() };
  } catch (error) { throw error instanceof EngineError ? error : new EngineError("OSTIUM_AUTHORIZATION_UNAVAILABLE", "The native delegate could not be verified. Keep automation disabled.", 503); }
}

export interface OstiumPriceTick { symbol: string; rawSymbol: string; bid: string; ask: string; mid: string; observedAt: number; isMarketOpen: boolean; isDayTradingClosed: boolean; schedule?: unknown }
let prices: { expiresAt: number; value: OstiumPriceTick[] } | undefined;
let pricesPending: Promise<OstiumPriceTick[]> | undefined;
export async function getOstiumPrices(): Promise<OstiumPriceTick[]> {
  if (prices && prices.expiresAt > Date.now()) return prices.value;
  if (pricesPending) return pricesPending;
  pricesPending = (async () => {
    const response = await fetch("https://builder.prod.bedrock.ostium.io/v1/prices", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (!response.ok || !response.body) throw new EngineError("OSTIUM_PRICES_UNAVAILABLE", "Ostium prices are unavailable.", 503);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 1_048_576) throw new Error("response bound"); chunks.push(chunk.value); }
    } catch { await reader.cancel().catch(() => undefined); throw new EngineError("OSTIUM_PRICES_UNAVAILABLE", "Ostium prices could not be verified.", 503); }
    finally { reader.releaseLock(); }
    const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(joined)) as { prices?: Array<Record<string, unknown>>; stale?: boolean };
    if (data.stale !== false || !Array.isArray(data.prices) || data.prices.length > 1_000) throw new EngineError("OSTIUM_STALE_PRICES", "Ostium prices are stale or unavailable.", 503);
    const value = data.prices.flatMap(tick => {
      const observedAt = Number(tick.timestampSeconds) * 1000;
      if (typeof tick.pair !== "string" || typeof tick.from !== "string" || typeof tick.to !== "string" || !Number.isSafeInteger(observedAt) || observedAt > Date.now() + 5_000 || Date.now() - observedAt > 20_000 || ![tick.bid, tick.ask, tick.mid].every(price => typeof price === "number" && Number.isFinite(price) && price > 0) || Number(tick.bid) > Number(tick.ask) || typeof tick.isMarketOpen !== "boolean" || typeof tick.isDayTradingClosed !== "boolean") return [];
      const plain = (value: unknown) => Number(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 });
      return [{ symbol: tick.pair.replace("-", "/"), rawSymbol: `${tick.from}/${tick.to}`, bid: plain(tick.bid), ask: plain(tick.ask), mid: plain(tick.mid), observedAt, isMarketOpen: tick.isMarketOpen, isDayTradingClosed: tick.isDayTradingClosed, schedule: tick.schedule }];
    });
    prices = { expiresAt: Date.now() + 3_000, value }; return value;
  })().catch(error => { throw error instanceof EngineError ? error : new EngineError("OSTIUM_PRICES_UNAVAILABLE", "Native market prices could not be verified.", 503); }).finally(() => { pricesPending = undefined; });
  return pricesPending;
}

export function pairSymbol(pair: OstiumPair) { return `${pair.pairFrom}/${pair.pairTo}`; }
export function priceForPair(pair: OstiumPair, ticks: OstiumPriceTick[]) { const symbol = pairSymbol(pair); return ticks.find(tick => tick.symbol === symbol || tick.rawSymbol === symbol); }
export const ostiumAddress = (value: string): Address => getAddress(value);
