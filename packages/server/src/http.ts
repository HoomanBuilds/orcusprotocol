import { timingSafeEqual } from "node:crypto";
import { getAddress, verifyMessage, type Hex } from "viem";
import { z } from "zod";
import type { HealthStatus, Market, MarketCandle, User } from "@orcus/core";
import { callEngine } from "./engine.js";
import { ApiError } from "./errors.js";
import { Platform } from "./platform.js";
import { getStore, type Store } from "./store.js";

const COOKIE = "orcus_session";
const address = z.string().regex(/^0x[\da-fA-F]{40}$/);
const decimal = z.string().max(80).regex(/^\d+(?:\.\d+)?$/);
const actionTypes = z.enum(["swap", "market", "limit", "cancel", "reduce", "close", "stop-loss", "take-profit"]);

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data, (_, value) => typeof value === "bigint" ? value.toString() : value), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

export async function readBody(request: Request, limit = 32_768): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new ApiError("BODY_TOO_LARGE", "Request body is too large.", 413);
  if (!request.body) return {};
  const reader = request.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit) { await reader.cancel(); throw new ApiError("BODY_TOO_LARGE", "Request body is too large.", 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (!length) return {};
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ApiError("INVALID_JSON", "Send a valid JSON request body."); }
}

function requestOrigin(request: Request): string {
  const origin = process.env.ORCUS_APP_URL ? new URL(process.env.ORCUS_APP_URL).origin : new URL(request.url).origin;
  const supplied = request.headers.get("origin");
  if (supplied !== origin || request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError("ORIGIN_REJECTED", "Use this application's own interface for account changes.", 403);
  return origin;
}

function sessionToken(request: Request): string | undefined {
  return request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}

function cookie(token: string, request: Request, clear = false) {
  return `${COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 86_400}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

function requireUser(request: Request, store: Store): User {
  const user = store.session(sessionToken(request));
  if (!user) throw new ApiError("AUTH_REQUIRED", "Connect your wallet and sign in first.", 401);
  return user;
}

function internalAuth(request: Request) {
  const expected = process.env.ORCUS_INTERNAL_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!expected || expected.length < 32 || !supplied || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new ApiError("INTERNAL_AUTH_REQUIRED", "The worker requires a configured internal credential.", 401);
}

const rpcMethods = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getBalance", "eth_getTransactionCount", "eth_estimateGas", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_gasPrice", "eth_getLogs"]);
const bundlerMethods = new Set(["eth_chainId", "eth_supportedEntryPoints", "eth_estimateUserOperationGas", "eth_sendUserOperation", "eth_getUserOperationReceipt", "eth_getUserOperationByHash", "zd_getUserOperationGasPrice", "pimlico_getUserOperationGasPrice"]);
const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string().max(100), z.number().finite(), z.null()]), method: z.string().max(100), params: z.array(z.unknown()).max(10).optional() }).strict();

async function proxyRpc(request: Request, user: User, platform: Platform, bundler: boolean) {
  const body = rpcSchema.parse(await readBody(request));
  if (!(bundler ? bundlerMethods : rpcMethods).has(body.method)) throw new ApiError("RPC_METHOD_REJECTED", "This RPC method is not supported by the application.", 403);
  const upstream = bundler ? process.env.ZERODEV_RPC_URL : process.env.SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
  if (!upstream) throw new ApiError("BUNDLER_UNCONFIGURED", "Configure ZERODEV_RPC_URL for the Sepolia trading account.", 503);
  if (bundler && ["eth_sendUserOperation", "eth_estimateUserOperationGas"].includes(body.method)) {
    const sender = (body.params?.[0] as { sender?: unknown } | undefined)?.sender;
    if (typeof sender !== "string" || !platform.accounts(user).some(account => account.venue === "uniswap" && account.smartAccountAddress?.toLowerCase() === sender.toLowerCase())) throw new ApiError("USER_OPERATION_ACCOUNT_MISMATCH", "This user operation is not for your registered trading account.", 403);
  }
  let response: Response;
  try { response = await fetch(upstream, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); }
  catch { throw new ApiError("RPC_UNAVAILABLE", "The testnet RPC is temporarily unavailable.", 503); }
  if (!response.ok) throw new ApiError("RPC_UNAVAILABLE", "The testnet RPC could not complete this request.", 503);
  const output = await readBody(new Request("http://localhost/response", { method: "POST", body: response.body, duplex: "half" } as RequestInit), 1_048_576);
  if (body.method === "eth_chainId" && (output as { result?: string }).result !== "0xaa36a7") throw new ApiError("WRONG_NETWORK", "The configured RPC is not Ethereum Sepolia.", 503);
  return json(output);
}

export async function handleRequest(request: Request, suppliedStore?: Store): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname.replace(/^\/api\/?/, ""), method = request.method;
    if (method === "OPTIONS") return new Response(null, { status: 405 });
    if (path === "health" && method === "GET") return json({ data: await callEngine<HealthStatus>("getHealth") });
    if (path === "wallet-config" && method === "GET") {
      const config = await callEngine<{ uniswap: { router: string; weth: string; usdc: string; quoter: string; factory: string } }>("engineConfig");
      const { router, weth, usdc, quoter, factory } = config.uniswap;
      return json({ data: { chainId: 11155111, rpcUrl: "/api/rpc", bundlerUrl: "/api/bundler", smartAccountsConfigured: Boolean(process.env.ZERODEV_RPC_URL), router, weth, usdc, quoter, factory, rpcUrlConfigured: Boolean(process.env.SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC) } });
    }
    if (path === "markets" && method === "GET") {
      const venue = z.enum(["uniswap", "hyperliquid"]).parse(url.searchParams.get("venue") ?? "hyperliquid");
      return json({ data: { markets: await callEngine<Market[]>("getMarkets", venue) } });
    }
    if (path === "candles" && method === "GET") {
      const venue = z.enum(["uniswap", "hyperliquid"]).parse(url.searchParams.get("venue") ?? "hyperliquid");
      const symbol = z.string().min(1).max(50).parse(url.searchParams.get("symbol") ?? "BTC");
      const interval = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).parse(url.searchParams.get("interval") ?? "1h");
      return json({ data: { candles: await callEngine<MarketCandle[]>("getCandles", { venue, symbol, interval }) } });
    }
    if (path === "orderbook" && method === "GET") return json({ data: await callEngine("getOrderBook", z.string().min(1).max(50).parse(url.searchParams.get("symbol") ?? "BTC")) });
    const store = suppliedStore ?? getStore(), platform = new Platform(store);
    if (path === "internal/tick" && method === "POST") { internalAuth(request); return json({ data: await platform.tick() }); }
    if (["POST", "PATCH", "DELETE"].includes(method)) requestOrigin(request);
    if (path === "auth/challenge" && method === "POST") {
      const input = z.object({ address }).strict().parse(await readBody(request));
      return json({ data: store.createChallenge(getAddress(input.address), requestOrigin(request)) });
    }
    if (path === "auth/verify" && method === "POST") {
      const input = z.object({ challengeId: z.string().uuid(), signature: z.string().regex(/^0x[\da-fA-F]{128,132}$/) }).strict().parse(await readBody(request));
      const challenge = store.challenge(input.challengeId);
      const expectedUri = `URI: ${requestOrigin(request)}\n`;
      if (!challenge.message.includes(expectedUri) || !await verifyMessage({ address: getAddress(challenge.address), message: challenge.message, signature: input.signature as Hex })) throw new ApiError("INVALID_SIGNATURE", "The signature does not match this sign-in challenge.", 401);
      const session = store.createSession(input.challengeId, challenge.address);
      return json({ data: platform.session(session.user) }, 200, { "Set-Cookie": cookie(session.token, request) });
    }
    if (path === "auth/logout" && method === "POST") { const token = sessionToken(request); if (token) store.logout(token); return json({ data: { loggedOut: true } }, 200, { "Set-Cookie": cookie("", request, true) }); }
    if (path === "session" && method === "GET") { const user = store.session(sessionToken(request)); return json({ data: user ? platform.session(user) : { user: null, agent: null, accounts: [] } }); }
    const user = requireUser(request, store);
    if (path === "rpc" && method === "POST") return proxyRpc(request, user, platform, false);
    if (path === "bundler" && method === "POST") return proxyRpc(request, user, platform, true);
    if (path === "portfolio" && method === "GET") return json({ data: await platform.portfolio(user) });
    if (path === "activity" && method === "GET") return json({ data: await platform.activity(user) });
    if (path === "accounts" && method === "GET") return json({ data: { accounts: platform.accounts(user) } });
    if (path === "accounts" && method === "POST") return json({ data: platform.createAccount(user, await readBody(request)) }, 201);
    if (path === "agent" && method === "GET") return json({ data: platform.agentState(user) });
    if (path === "agent/control" && method === "POST") {
      const input = z.object({ command: z.enum(["pause", "resume", "take-over", "update"]), mode: z.enum(["approval-required", "autonomous"]).optional(), preferences: z.string().max(4000).optional(), privateInferenceRequired: z.boolean().optional() }).strict().parse(await readBody(request));
      return json({ data: platform.control(user, input) });
    }
    if (path === "agent/chat" && method === "POST") {
      const input = z.object({ message: z.string().min(1).max(10_000), accountId: z.string().max(100).optional(), autonomous: z.boolean().optional(), requestId: z.string().min(1).max(100).optional() }).strict().parse(await readBody(request));
      return json({ data: await platform.chat(user, input) });
    }
    if (path === "actions/prepare" && method === "POST") return json({ data: await platform.prepare(user, await readBody(request), request.headers.get("idempotency-key") ?? undefined) });
    if (path === "actions/submit" && method === "POST") {
      const input = z.object({ actionId: z.string().min(1).max(100), transactionHash: z.string().optional(), txHash: z.string().optional(), userOperationHash: z.string().optional(), orderId: z.string().max(100).optional(), response: z.unknown().optional(), result: z.unknown().optional() }).strict().parse(await readBody(request));
      return json({ data: await platform.submit(user, input) });
    }
    if (path === "permissions" && method === "GET") return json({ data: { permissions: platform.agentState(user).permissions } });
    if (path === "permissions" && method === "POST") {
      const input = z.object({ accountId: z.string().min(1).max(100), action: z.enum(["prepare", "activate", "revoke", "rotate"]), expiresAt: z.number().int().optional(), maxTradeUsd: decimal.optional(), allowedSymbols: z.array(z.string().max(50)).max(30).optional(), allowedActions: z.array(actionTypes).max(10).optional(), authorization: z.unknown().optional() }).strict().parse(await readBody(request));
      return json({ data: await platform.permission(user, input) });
    }
    if (path === "automations" && method === "GET") return json({ data: platform.automations(user) });
    if (path === "automations" && method === "POST") return json({ data: platform.createAutomation(user, await readBody(request)) }, 201);
    const automationMatch = path.match(/^automations\/([^/]+)$/);
    if (automationMatch && method === "PATCH") {
      const input = z.object({ status: z.enum(["active", "paused"]).optional(), instruction: z.string().min(1).max(2000).optional(), intervalSeconds: z.number().int().min(60).max(86400).optional() }).strict().parse(await readBody(request));
      return json({ data: platform.updateAutomation(user, automationMatch[1], input) });
    }
    if (path === "budget" && method === "GET") return json({ data: platform.budget(user) });
    if (path === "budget" && method === "POST") {
      const input = z.object({ limitUsd: decimal.optional(), capUsd: decimal.optional(), lowBalanceUsd: decimal.optional(), autoReplenish: z.boolean().optional() }).strict().parse(await readBody(request));
      return json({ data: platform.setBudget(user, input) });
    }
    if (path === "memory" && method === "POST") { const input = z.object({ action: z.enum(["backup", "restore"]) }).strict().parse(await readBody(request)); return json({ data: await platform.memory(user, input.action) }); }
    return json({ error: { code: "NOT_FOUND", message: "This API route does not exist." } }, 404);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: { code: "INVALID_INPUT", message: error.issues[0]?.message ?? "Invalid request." } }, 400);
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof Error && "code" in error && "status" in error && typeof error.code === "string" && typeof error.status === "number") return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: "REQUEST_FAILED", message: "The service could not complete this request. Check its configuration and try again." } }, 500);
  }
}
