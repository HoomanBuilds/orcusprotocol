import { timingSafeEqual } from "node:crypto";
import { getAddress, verifyMessage, type Hex } from "viem";
import { z } from "zod";
import { agentModelIdSchema,automationUpdateSchema,tradeActionSchema,venueSchema,type HealthStatus,type Market,type MarketCandle,type User } from "@orcus/core";
import { agentRequestSchema, storedAgentRequest } from "./agent-requests";
import { selectedAgentModel } from "./agent-models";
import { callEngine } from "./engine";
import { ApiError } from "./errors";
import { Platform } from "./platform";
import { getStore, type Store } from "./store";
import { assertNoPaymaster, operationScopeSchema, recordSelfFundedBroadcast, selfFundedSummary, settleSelfFundedReceipt } from "./self-funded";
import { entryPoint, resolveKernelBundlerUrl } from "@orcus/wallets/kernel";
import { cancelServicePayment, createServicePayment, reconcileServicePayment, recordServicePaymentSubmission, servicePaymentSummary } from "./service-payments";
import { reconcileComputeExpense } from "./budget";
import { cancelOstiumAllowance,listOstiumAllowances,prepareOstiumAllowance,reconcileOstiumAllowance,submitOstiumAllowance } from "./ostium-allowances";

const COOKIE = "orcus_session";
const address = z.string().regex(/^0x[\da-fA-F]{40}$/);
const decimal = z.string().max(80).regex(/^\d+(?:\.\d+)?$/);
const actionTypes = tradeActionSchema;

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
  if (bundler && !selfFundedSummary().configured) throw new ApiError("BUNDLER_UNCONFIGURED", "Configure BUNDLER_RPC_URL for self-funded Sepolia smart-account execution.", 503);
  const upstream = bundler ? resolveKernelBundlerUrl({ BUNDLER_RPC_URL: process.env.BUNDLER_RPC_URL }) : process.env.SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
  if (bundler && ["eth_sendUserOperation", "eth_estimateUserOperationGas"].includes(body.method)) {
    assertNoPaymaster(body.params?.[0]);
    if (body.params?.[1] !== entryPoint.address) throw new ApiError("USER_OPERATION_ENTRYPOINT_MISMATCH", "Only EntryPoint v0.7 is supported.", 403);
    const sender = (body.params?.[0] as { sender?: unknown } | undefined)?.sender;
    if (typeof sender !== "string" || !platform.accounts(user).some(account => account.venue === "uniswap" && account.smartAccountAddress?.toLowerCase() === sender.toLowerCase())) throw new ApiError("USER_OPERATION_ACCOUNT_MISMATCH", "This user operation is not for your registered trading account.", 403);
  }
  if (bundler && body.method === "eth_sendUserOperation") {
    const scope = operationScopeSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    await recordSelfFundedBroadcast(platform.store, user, scope, body.params?.[0]);
  }
  let response: Response;
  try { response = await fetch(upstream, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error" }); }
  catch { throw new ApiError("RPC_UNAVAILABLE", "The testnet RPC is temporarily unavailable.", 503); }
  if (!response.ok) throw new ApiError("RPC_UNAVAILABLE", "The testnet RPC could not complete this request.", 503);
  const output = await readBody(new Request("http://localhost/response", { method: "POST", body: response.body, duplex: "half" } as RequestInit), 1_048_576);
  const upstreamError = (output as { error?: { data?: unknown } }).error;
  if (upstreamError) {
    const data = upstreamError.data;
    const revertData = !bundler && body.method === "eth_call" && typeof data === "string" && data.length <= 32_770 && /^0x(?:[\da-fA-F]{2})*$/.test(data) ? data : undefined;
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "The configured RPC rejected this request. Provider details were withheld.", ...(revertData === undefined ? {} : { data: revertData }) } });
  }
  if (body.method === "eth_chainId" && (output as { result?: string }).result !== "0xaa36a7") throw new ApiError("WRONG_NETWORK", "The configured RPC is not Ethereum Sepolia.", 503);
  if (bundler && body.method === "eth_getUserOperationReceipt") settleSelfFundedReceipt(platform.store, user, (output as { result?: unknown }).result);
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
      const gasPayment = selfFundedSummary();
      return json({ data: { chainId: 11155111, rpcUrl: "/api/rpc", bundlerUrl: "/api/bundler", smartAccountsConfigured: gasPayment.configured, gasPayment, gasSponsorship: { required: false, configured: false, status: "disabled" }, router, weth, usdc, quoter, factory, rpcUrlConfigured: Boolean(process.env.SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC) } });
    }
    if (path === "markets" && method === "GET") {
      const venue = venueSchema.parse(url.searchParams.get("venue") ?? "hyperliquid");
      return json({ data: { markets: await callEngine<Market[]>("getMarkets", venue) } });
    }
    if (path === "candles" && method === "GET") {
      const venue = venueSchema.parse(url.searchParams.get("venue") ?? "hyperliquid");
      const symbol = z.string().min(1).max(50).parse(url.searchParams.get("symbol") ?? "BTC");
      const interval = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).parse(url.searchParams.get("interval") ?? "1h");
      return json({ data: { candles: await callEngine<MarketCandle[]>("getCandles", { venue, symbol, interval }) } });
    }
    if (path === "orderbook" && method === "GET") {
      const venue=venueSchema.parse(url.searchParams.get("venue")??"hyperliquid");
      if(venue!=="hyperliquid")throw new ApiError("ORDER_BOOK_UNAVAILABLE","This venue does not expose a supported order book; no other venue's data is substituted.",503);
      return json({ data: await callEngine("getOrderBook", z.string().min(1).max(50).parse(url.searchParams.get("symbol") ?? "BTC")) });
    }
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
    if (path === "rpc" && method === "POST") return await proxyRpc(request, user, platform, false);
    if (path === "bundler" && method === "POST") return await proxyRpc(request, user, platform, true);
    if (path === "paymaster" || path.startsWith("gas-sponsorship")) throw new ApiError("SPONSORSHIP_DISABLED", "Gas sponsorship is disabled. Trading accounts pay their own network fees.", 410);
    if (path === "portfolio" && method === "GET") return json({ data: await platform.portfolio(user) });
    if (path === "activity" && method === "GET") return json({ data: await platform.activity(user) });
    if (path === "accounts" && method === "GET") return json({ data: { accounts: platform.accounts(user) } });
    if (path === "accounts" && method === "POST") return json({ data: platform.createAccount(user, await readBody(request)) }, 201);
    const historyAccount=path.match(/^accounts\/([^/]+)\/history$/);
    if(historyAccount&&method==="GET"){
      const account=platform.account(user,z.string().min(1).max(100).parse(historyAccount[1]));
      if(account.venue!=="ostium")throw new ApiError("HISTORY_UNAVAILABLE","This route supports native Ostium history only; shared app activity remains separate.",503);
      return json({data:{accountId:account.id,venue:account.venue,history:await callEngine("getOstiumHistory",account)}});
    }
    if(path==="ostium/allowances"&&method==="GET")return json({data:listOstiumAllowances(store,user)});
    if(path==="ostium/allowances/prepare"&&method==="POST")return json({data:await prepareOstiumAllowance(store,user,await readBody(request))},201);
    if(["ostium/allowances/submit","ostium/allowances/reconcile","ostium/allowances/cancel"].includes(path)&&method==="POST"){
      const input=z.object({intentId:z.string().min(1).max(150),transactionHash:z.string().regex(/^0x[\da-fA-F]{64}$/).optional(),ownerRejected:z.literal(true).optional(),preflightFailed:z.literal(true).optional(),submissionToken:z.uuid().optional()}).strict().parse(await readBody(request));
      if((input.ownerRejected||input.preflightFailed)&&!path.endsWith("/cancel")||input.ownerRejected&&input.preflightFailed||input.transactionHash&&path.endsWith("/cancel"))throw new ApiError("INVALID_ALLOWANCE_TRANSITION","Unsigned wallet failures belong to cancellation, and signed hashes must be reconciled.",400);
      if(input.submissionToken&&(input.transactionHash||path.endsWith("/reconcile")||path.endsWith("/cancel")&&!input.preflightFailed&&!input.ownerRejected)||input.preflightFailed&&!input.submissionToken)throw new ApiError("INVALID_ALLOWANCE_TRANSITION","A submission token belongs only to its unsigned claim and cancellation.",400);
      return json({data:path.endsWith("/submit")?submitOstiumAllowance(store,user,input.intentId,input.transactionHash,input.submissionToken):path.endsWith("/reconcile")?await reconcileOstiumAllowance(store,user,input.intentId,input.transactionHash):cancelOstiumAllowance(store,user,input.intentId,input.ownerRejected,input.preflightFailed,input.submissionToken)});
    }
    if (path === "agent" && method === "GET") return json({ data: platform.agentState(user) });
    if (path === "agent/models" && method === "GET") return json({ data: await callEngine("getAgentModels", platform.agent(user).modelId) });
    if (path === "agent/requests" && method === "GET") return json({ data: platform.agentRequests(user) });
    if (path === "agent/requests" && method === "POST") {
      const input=agentRequestSchema.parse(await readBody(request));
      if(storedAgentRequest(store,user.id,input.requestId))return json({data:platform.enqueueChat(user,input)},202);
      if(input.modelId!==undefined&&selectedAgentModel(input.modelId)!==selectedAgentModel())await callEngine("validateAgentModel",input.modelId);
      return json({ data: platform.enqueueChat(user, input) }, 202);
    }
    const agentRequestMatch=path.match(/^agent\/requests\/([^/]+)$/);
    if(agentRequestMatch&&method==="GET")return json({data:platform.agentRequest(user,z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/).parse(decodeURIComponent(agentRequestMatch[1])))});
    const runMatch=path.match(/^agent\/runs\/([^/]+)$/);
    if(runMatch&&method==="GET")return json({data:platform.runStatus(user,z.string().max(100).parse(runMatch[1]))});
    if (path === "agent/control" && method === "POST") {
      const input = z.object({ modelId: agentModelIdSchema.optional(), command: z.enum(["pause", "resume", "take-over", "update"]), mode: z.enum(["approval-required", "autonomous"]).optional(), preferences: z.string().max(4000).optional(), privateInferenceRequired: z.boolean().optional(), privateVerification: z.enum(["independent-gateway", "gateway-reported"]).optional() }).strict().parse(await readBody(request));
      if(input.modelId!==undefined){if(input.command!=="update")throw new ApiError("INVALID_MODEL_CONTROL","Use update to choose the model for future requests.");if(selectedAgentModel(input.modelId)!==selectedAgentModel())await callEngine("validateAgentModel",input.modelId);}
      return json({ data: platform.control(user, input) });
    }
    if (path === "agent/chat" && method === "POST") {
      const input = z.object({ modelId: agentModelIdSchema.optional(), message: z.string().min(1).max(10_000), accountId: z.string().max(100).optional(), autonomous: z.boolean().optional(), requestId: z.string().min(1).max(100).optional() }).strict().parse(await readBody(request));
      return json({ data: await platform.chat(user, input) });
    }
    if (path === "actions/prepare" && method === "POST") return json({ data: await platform.prepare(user, await readBody(request), request.headers.get("idempotency-key") ?? undefined,request.headers.get("x-orcus-initiator")==="agent"?"agent":"manual",{messageId:z.string().min(1).max(200).optional().parse(request.headers.get("x-orcus-message-id")??undefined)}) });
    if (path === "actions/submit" && method === "POST") {
      const input = z.object({ actionId: z.string().min(1).max(100), transactionHash: z.string().optional(), txHash: z.string().optional(), userOperationHash: z.string().optional(), orderId: z.string().max(100).optional(),approvalIndex:z.number().int().min(0).max(4).optional(), response: z.unknown().optional(), result: z.unknown().optional() }).strict().parse(await readBody(request));
      return json({ data: await platform.submit(user, input) });
    }
    if (path === "permissions" && method === "GET") return json({ data: { permissions: platform.agentState(user).permissions } });
    if (path === "permissions" && method === "POST") {
      const input = z.object({ accountId: z.string().min(1).max(100), action: z.enum(["prepare", "activate", "revoke", "rotate"]), permissionId:z.string().min(1).max(100).optional(),expiresAt: z.number().int().optional(), maxTradeUsd: decimal.optional(),maxCollateralUsd:decimal.optional(),maxLeverage:z.number().finite().min(1).max(1000).optional(), allowNativeInput:z.boolean().optional(),allowedSymbols: z.array(z.string().max(50)).max(30).optional(), allowedActions: z.array(actionTypes).max(12).optional(), authorization: z.unknown().optional() }).strict().parse(await readBody(request));
      return json({ data: await platform.permission(user, input) });
    }
    if (path === "automations" && method === "GET") return json({ data: platform.automations(user) });
    if(path==="notifications"&&method==="GET")return json({data:platform.notifications(user)});
    const notificationMatch=path.match(/^notifications\/([^/]+)$/);
    if(notificationMatch&&method==="PATCH"){z.object({read:z.literal(true)}).strict().parse(await readBody(request));return json({data:platform.readNotification(user,notificationMatch[1])});}
    if (path === "automations" && method === "POST") return json({ data: platform.createAutomation(user, await readBody(request),z.string().min(1).max(200).optional().parse(request.headers.get("idempotency-key")??undefined)) }, 201);
    const automationMatch = path.match(/^automations\/([^/]+)$/);
    if (automationMatch && method === "PATCH") {
      const input = automationUpdateSchema.parse(await readBody(request));
      return json({ data: platform.updateAutomation(user, automationMatch[1], input) });
    }
    if (path === "budget" && method === "GET") return json({ data: await platform.budget(user) });
    if (path === "budget" && method === "POST") {
      const input = z.object({ limitUsd: decimal.optional(), capUsd: decimal.optional(), lowBalanceUsd: decimal.optional(), autoReplenish: z.boolean().optional() }).strict().parse(await readBody(request));
      return json({ data: await platform.setBudget(user, input) });
    }
    if (path === "budget/reconcile" && method === "POST") {
      const input = z.object({ expenseId: z.string().min(1).max(100) }).strict().parse(await readBody(request));
      return json({ data: await reconcileComputeExpense(store, user.id, input.expenseId) });
    }
    if (path === "budget/payments" && method === "GET") return json({ data: servicePaymentSummary(store, user) });
    if (path === "budget/payments/intent" && method === "POST") return json({ data: await createServicePayment(store, user, await readBody(request)) }, 201);
    if (["budget/payments/submit", "budget/payments/reconcile", "budget/payments/cancel"].includes(path) && method === "POST") {
      const input = z.object({ intentId: z.string().min(1).max(100), transactionHash: z.string().regex(/^0x[\da-fA-F]{64}$/).optional() }).strict().parse(await readBody(request));
      return json({ data: path.endsWith("/submit") ? recordServicePaymentSubmission(store, user, input.intentId, input.transactionHash) : path.endsWith("/reconcile") ? await reconcileServicePayment(store, user, input.intentId, input.transactionHash) : cancelServicePayment(store, user, input.intentId) });
    }
    if(path==="budget/funding"&&method==="GET")return json({data:platform.computeFunding(user)});
    if(path==="budget/funding/policy"&&method==="POST")return json({data:await platform.setComputeFunding(user,await readBody(request))});
    if(path==="budget/funding/prepare"&&method==="POST"){
      const input=z.object({requestId:z.string().min(1).max(150)}).strict().parse(await readBody(request));
      return json({data:await platform.prepareFunding(user,input.requestId)});
    }
    if(["budget/funding/submit","budget/funding/reconcile","budget/funding/cancel"].includes(path)&&method==="POST"){
      const input=z.object({intentId:z.string().min(1).max(100)}).strict().parse(await readBody(request));
      return json({data:path.endsWith("/submit")?await platform.submitFunding(user,input.intentId):path.endsWith("/reconcile")?await platform.reconcileFunding(user,input.intentId):platform.cancelFunding(user,input.intentId)});
    }
    if(path==="memory"&&method==="GET")return json({data:platform.memories(user,url.searchParams.get("query")??undefined)});
    if(path==="memory/notes"&&method==="POST")return json({data:platform.remember(user,await readBody(request))},201);
    const memoryMatch=path.match(/^memory\/notes\/([^/]+)$/);
    if(memoryMatch&&method==="DELETE")return json({data:{forgotten:platform.forgetMemory(user,z.string().max(100).parse(memoryMatch[1]))}});
    if(path==="memory/reconcile"&&method==="POST"){
      const input=z.object({expenseId:z.string().min(1).max(100)}).strict().parse(await readBody(request));
      return json({data:await platform.reconcileStorage(user,input.expenseId)});
    }
    if (path === "memory" && method === "POST") {
      const cap=z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,18})?$/).refine(value=>/[1-9]/.test(value),"Use a positive native 0G expense cap");
      const input=z.object({action:z.enum(["backup","restore"]),maxGas0G:cap.optional(),maxStorageFee0G:cap.optional(),expectedFlowAddress:address.optional()}).strict().parse(await readBody(request));
      return json({data:await platform.memory(user,input.action,{maxGas0G:input.maxGas0G,maxStorageFee0G:input.maxStorageFee0G,expectedFlowAddress:input.expectedFlowAddress})});
    }
    return json({ error: { code: "NOT_FOUND", message: "This API route does not exist." } }, 404);
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: { code: "INVALID_INPUT", message: error.issues[0]?.message ?? "Invalid request." } }, 400);
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof Error && "code" in error && "status" in error && typeof error.code === "string" && typeof error.status === "number") return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: "REQUEST_FAILED", message: "The service could not complete this request. Check its configuration and try again." } }, 500);
  }
}
