import { randomUUID } from "node:crypto";
import { CancelOrderType, OrderType } from "@ostium/builder-sdk";
import { createWalletClient, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress, http, isAddressEqual, keccak256, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { tradeRequestSchema, type PreparedAction, type TradingAccount, type TradeRequest } from "@orcus/core";
import { inspectPreparedOstiumAction, OSTIUM_TESTNET, ostiumTradingAbi, type OstiumExecutionContext, type OstiumPreparedAction } from "@orcus/wallets/ostium";
import { EngineError } from "../../errors";
import type { SubmissionResult } from "../../types";
import { decimalToAtoms } from "../hyperliquid/wire-format";
import { boundedOstiumRead, getOstiumAuthorization, getOstiumPrices, ostiumRpcUrl, ostiumSdk, pairSymbol, priceForPair, verifiedOstiumRpc, type OstiumBuiltTx } from "./client";
import { assertOstiumAccount, getOstiumPair, orderKey, positionKey } from "./data";

const same = (left: string, right: string) => isAddressEqual(getAddress(left), getAddress(right));
const positive = (value: string, decimals = 18) => { const amount = decimalToAtoms(value, decimals); if (amount <= 0n) throw new EngineError("INVALID_AMOUNT", "Enter a positive exact amount."); return amount; };
const nonnegativePrice = (value: string) => decimalToAtoms(value, 18);
const plain = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const asTransaction = (value: OstiumBuiltTx, owner: string, label: string, sender = owner) => {
  if (value.kind !== "eoa" || !same(value.traderAddress, owner) || !same(value.from, sender) || value.value !== 0n) throw new EngineError("OSTIUM_CALL_MISMATCH", "The SDK did not build the expected owner-bound EOA transaction.");
  return { to: value.to, data: value.data, value: "0", chainId: 421614, label };
};

export async function prepareOstiumAction(input: TradeRequest, account: TradingAccount): Promise<OstiumPreparedAction> {
  try {
  let action = tradeRequestSchema.parse(input);
  assertOstiumAccount(account);
  if (action.accountId !== account.id || String(action.venue) !== "ostium") throw new EngineError("ACCOUNT_MISMATCH", "The action belongs to a different venue account.");
  if (action.nativeInput || action.tokenIn || action.tokenOut) throw new EngineError("UNSUPPORTED_ACTION", "Ostium uses its own testnet USDC collateral, not spot swaps or native ETH input.");
  const rpc = await verifiedOstiumRpc(), trader = getAddress(account.address);
  if (await rpc.readContract({ address: OSTIUM_TESTNET.trading, abi: ostiumTradingAbi, functionName: "isDone" })) throw new EngineError("OSTIUM_CLOSED", "The current Ostium trading contract is closed.", 503);
  const pair = await getOstiumPair(action.symbol), ticks = await getOstiumPrices(), tick = priceForPair(pair, ticks);
  const opening = ["market", "limit", "stop"].includes(String(action.type)), agent = action.mode === "agent";
  if (!tick) throw new EngineError("OSTIUM_STALE_PRICES", "A fresh price is required before changing this Ostium position.", 503);
  if (opening && (pair.maxLeverage <= 0 || !tick.isMarketOpen || await rpc.readContract({ address: OSTIUM_TESTNET.trading, abi: ostiumTradingAbi, functionName: "isPaused" }))) throw new EngineError("OSTIUM_MARKET_DISABLED", "This Ostium testnet market is not currently accepting new positions.", 409);
  if (agent) {
    if (!account.agentAddress || account.status !== "authorized") throw new EngineError("AGENT_NOT_AUTHORIZED", "Authorize this account's agent first.", 403);
    const native = await getOstiumAuthorization({ trader, chainId: account.chainId });
    if (!same(native.delegate, account.agentAddress)) throw new EngineError("AGENT_NOT_AUTHORIZED", "The current native Ostium delegate does not match this agent.", 403);
    if (String(action.type) === "remove-collateral") throw new EngineError("OWNER_ONLY", "Collateral removal requires the owner's explicit signature.", 403);
  }
  const client = await ostiumSdk(trader, agent ? account.agentAddress : undefined);
  const balances = await boundedOstiumRead(() => client.getBalances(trader));
  const scope: OstiumExecutionContext = { pairId: Number(pair.pairId), symbol: pairSymbol(pair), trader, recipient: trader, chainId: 421614, amountUnit: action.amountUnit === "collateral-usdc" ? "collateral-usdc" : "base", collateralUsd: "0", leverage: 1, builderFeeBps: 0, delegate: agent ? account.agentAddress : undefined, functionName: "", expectedData: "0x", requiredAllowanceUsd: "0", notionalUsd: "0", marketObservedAt: tick.observedAt, minimumBlock: (await rpc.getBlockNumber()).toString() };
  let native: OstiumBuiltTx;
  if (opening) {
    if (action.amountUnit !== "collateral-usdc") throw new EngineError("AMOUNT_UNIT_REQUIRED", "Enter Ostium opening collateral in USDC, separately from notional exposure.");
    const collateral = positive(action.amount, 6), leverage = action.leverage ?? 1;
    const leverageAtoms = positive(String(leverage), 2);
    if (collateral < 5_000_000n || collateral > 2_000_000_000_000n || leverage < pair.minLeverage || leverage > pair.maxLeverage) throw new EngineError("OSTIUM_TRADE_LIMIT", "Collateral or leverage is outside this market's current limits.");
    if (pair.overnightMaxLeverage > 0 && leverage > pair.overnightMaxLeverage && !action.isDayTrade || action.isDayTrade && tick.isDayTradingClosed) throw new EngineError("OSTIUM_DAY_TRADE_REQUIRED", "Review the day-trade and overnight leverage limits before opening.");
    if (String(action.type) !== "market" && !action.price) throw new EngineError("PRICE_REQUIRED", "Enter the limit or stop-entry price.");
    if (action.price) positive(action.price);
    if (action.takeProfit !== undefined) nonnegativePrice(action.takeProfit);
    if (action.stopLoss !== undefined) nonnegativePrice(action.stopLoss);
    const preview = await boundedOstiumRead(() => client.previewOpenTrade({ pairId: pair.pairId, isLong: action.side === "buy", collateral: Number(action.amount), leverage, limitPrice: String(action.type) === "market" ? undefined : Number(action.price), isDayTrade: action.isDayTrade, builderFeeBps: 0 }));
    if (!preview.isValid || preview.withinExposureLimit !== true) throw new EngineError("OSTIUM_PREVIEW_REJECTED", "The current venue preview could not approve this trade's fees, exposure and limits.", 422);
    const price = String(action.type) === "market" ? preview.entryPx : action.price!;
    positive(price);
    action = { ...action, price, leverage };
    native = client.getOpenTradeTx({ pairId: pair.pairId, buy: action.side === "buy", collateral: action.amount, leverage: String(leverage), price, type: ({ market: OrderType.Market, limit: OrderType.Limit, stop: OrderType.Stop } as Record<string, OrderType>)[String(action.type)], takeProfit: action.takeProfit, stopLoss: action.stopLoss, slippage: action.slippageBps, isDayTrade: action.isDayTrade, builder: { address: zeroAddress, feeBps: 0 } });
    Object.assign(scope, { collateralUsd: action.amount, leverage, notionalUsd: formatUnits((collateral * leverageAtoms + 99n) / 100n, 6), requiredAllowanceUsd: action.amount, preview: plain(preview) });
  } else if (String(action.type) === "cancel" || String(action.type) === "edit-order") {
    if (!action.orderId) throw new EngineError("ORDER_REQUIRED", "Choose an exact order to manage.");
    const pending = /^pending-(open|close):(\d+)$/.exec(action.orderId);
    if (pending && String(action.type) === "cancel") {
      const orders = await boundedOstiumRead(() => client.getOrders({ user: trader, orderIds: [pending[2]], limit: 2 }));
      const own = orders.filter(order => same(order.trader, trader) && order.isPending && order.pairId === pair.pairId && order.oid === pending[2]);
      if (own.length !== 1 || pending[1] === "open" && own[0].action !== "Open" || pending[1] === "close" && own[0].action !== "Close" || BigInt(pending[2]) > BigInt(Number.MAX_SAFE_INTEGER)) throw new EngineError("ORDER_NOT_FOUND", "The pending order could not be uniquely verified for this account.");
      native = client.getCancelOrderTx(pending[1] === "open" ? { type: CancelOrderType.PendingOpen, orderId: Number(pending[2]) } : { type: CancelOrderType.PendingClose, orderId: Number(pending[2]), retry: false });
    } else {
      const orders = await boundedOstiumRead(() => client.getOpenOrders({ user: trader }));
      const matches = orders.filter(order => same(order.trader, trader) && order.pairId === pair.pairId && orderKey(order.pairId, order.idx) === action.orderId);
      if (matches.length !== 1) throw new EngineError("ORDER_NOT_FOUND", "The selected order no longer exists for this account.");
      const order = matches[0]; scope.orderIndex = order.idx;
      if (String(action.type) === "cancel") native = client.getCancelOrderTx({ type: CancelOrderType.Limit, pairId: pair.pairId, idx: order.idx });
      else {
        if (!action.price || action.takeProfit === undefined || action.stopLoss === undefined) throw new EngineError("PROTECTION_REVIEW_REQUIRED", "Review the price and both protective levels. Use zero only to explicitly clear a level.");
        positive(action.price); nonnegativePrice(action.takeProfit); nonnegativePrice(action.stopLoss);
        native = client.getModifyOrderTx({ pairId: pair.pairId, idx: order.idx, target: "limit", price: action.price, takeProfit: action.takeProfit, stopLoss: action.stopLoss });
        Object.assign(scope, { collateralUsd: order.collateralUsed, leverage: Number(order.leverage), notionalUsd: order.ntl });
      }
    }
  } else {
    if (!action.positionId) throw new EngineError("POSITION_REQUIRED", "Choose an exact Ostium position to manage.");
    const current = await boundedOstiumRead(() => client.getOpenPositions({ user: trader, limit: 200 }));
    const positions = current.pairPositions.map(item => item.position).filter(position => same(position.trader, trader) && position.pairId === pair.pairId && positionKey(position.pairId, position.pid) === action.positionId && position.idx >= 0);
    if (positions.length !== 1) throw new EngineError("POSITION_NOT_FOUND", "The selected position no longer uniquely matches this account.");
    const position = positions[0];
    Object.assign(scope, { positionId: action.positionId, positionIndex: position.idx, positionSize: position.szi, collateralUsd: position.collateralUsed, leverage: Number(position.leverage), notionalUsd: position.ntl });
    if (["close", "reduce"].includes(String(action.type))) {
      if (action.amountUnit && action.amountUnit !== "base") throw new EngineError("AMOUNT_UNIT_REQUIRED", "Position exits use base-asset quantity, not collateral USDC.");
      const size = positive(position.szi), requested = String(action.type) === "close" ? size : positive(action.amount);
      if (requested > size) throw new EngineError("REDUCE_EXCEEDS_POSITION", "The requested reduction exceeds the current position.");
      const bps = requested === size ? 10_000 : Number(requested * 10_000n / size);
      if (bps < 100) throw new EngineError("OSTIUM_REDUCTION_TOO_SMALL", "Ostium's SDK requires closing at least one percent of the current position.");
      const preview = await boundedOstiumRead(() => client.previewCloseTrade({ pairId: pair.pairId, idx: position.idx, user: trader, closePercent: bps / 100 }));
      const price = preview.exitPx; positive(price);
      action = { ...action, amount: formatUnits(size * BigInt(bps) / 10_000n, 18), amountUnit: "base", price, reduceOnly: true, side: position.side === "B" ? "sell" : "buy" };
      native = client.getCloseTradeTx({ pairId: pair.pairId, idx: position.idx, price, closePercent: bps / 100, slippage: action.slippageBps });
      Object.assign(scope, { closePercentBps: bps, collateralUsd: formatUnits(decimalToAtoms(position.collateralUsed, 18) * BigInt(bps) / 10_000n, 18), notionalUsd: formatUnits((decimalToAtoms(position.ntl, 18) * BigInt(bps) + 9_999n) / 10_000n, 18), requiredAllowanceUsd: pair.oracleFee, preview: plain(preview) });
    } else if (["stop-loss", "take-profit"].includes(String(action.type))) {
      const level = String(action.type) === "stop-loss" ? action.stopLoss ?? action.triggerPrice : action.takeProfit ?? action.triggerPrice;
      if (level === undefined) throw new EngineError("TRIGGER_REQUIRED", "Enter the exact protective level, or explicitly clear it with zero.");
      nonnegativePrice(level);
      native = client.getModifyOrderTx({ pairId: pair.pairId, idx: position.idx, target: "position", ...(String(action.type) === "stop-loss" ? { stopLoss: level } : { takeProfit: level }) });
    } else if (["add-collateral", "remove-collateral"].includes(String(action.type))) {
      if (action.amountUnit !== "collateral-usdc") throw new EngineError("AMOUNT_UNIT_REQUIRED", "Collateral changes use USDC, not base-asset size.");
      const amount = positive(action.amount, 6), removing = String(action.type) === "remove-collateral";
      if (amount > 2_000_000_000_000n || removing && amount * 1_000_000_000_000n > decimalToAtoms(position.maxWithdrawable, 18)) throw new EngineError("OSTIUM_COLLATERAL_LIMIT", "The collateral change exceeds the current safe venue limit.");
      if (!removing && decimalToAtoms(balances.allowance, 6) < amount) throw new EngineError("OSTIUM_ALLOWANCE_REQUIRED", "Approve this exact USDC collateral allowance as the owner, wait for confirmation, then review the collateral addition.", 409);
      native = await boundedOstiumRead(() => client.getUpdateCollateralTx({ pairId: pair.pairId, idx: position.idx, amount: removing ? `-${action.amount}` : action.amount }));
      Object.assign(scope, { ownerOnly: removing, collateralUsd: removing ? position.collateralUsed : formatUnits(decimalToAtoms(position.collateralUsed, 18) + amount * 1_000_000_000_000n, 18), requiredAllowanceUsd: removing ? pair.oracleFee : action.amount });
    } else throw new EngineError("UNSUPPORTED_ACTION", "This action is not supported by the Ostium adapter.");
  }
  const required = decimalToAtoms(scope.requiredAllowanceUsd, 6);
  if (required > decimalToAtoms(balances.usdc, 6)) throw new EngineError("INSUFFICIENT_BALANCE", "The owner needs enough Ostium testnet USDC for collateral and any oracle fee.", 402);
  const transactions: NonNullable<PreparedAction["transactions"]> = [];
  if (decimalToAtoms(balances.allowance, 6) < required) {
    if (agent) throw new EngineError("OSTIUM_ALLOWANCE_REQUIRED", "The owner must approve the exact USDC allowance before the agent can execute.", 409);
    if (decimalToAtoms(balances.allowance, 6) > 0n) transactions.push({ to: OSTIUM_TESTNET.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OSTIUM_TESTNET.storage, 0n] }), value: "0", chainId: 421614, label: "Reset the existing Ostium USDC allowance" });
    transactions.push(asTransaction(client.getApproveUsdcTx(scope.requiredAllowanceUsd), trader, `Approve exactly ${scope.requiredAllowanceUsd} testnet USDC`));
  }
  const transaction = asTransaction(native, trader, "Submit the reviewed Ostium testnet action", agent ? account.agentAddress! : trader);
  let data = transaction.data;
  const outer = decodeFunctionData({ abi: ostiumTradingAbi, data });
  if (outer.functionName === "delegatedAction") data = outer.args[1];
  scope.expectedData = data; scope.functionName = decodeFunctionData({ abi: ostiumTradingAbi, data }).functionName;
  const prepared: OstiumPreparedAction = { id: randomUUID(), request: action, account, kind: "evm", transactions: [...transactions, transaction], ostium: scope, expiresAt: Date.now() + 60_000, controlRevision: account.controlRevision, warnings: ["Arbitrum Sepolia testnet only. These positions provide leveraged price exposure, not ownership of the underlying asset.", agent ? "Fund your agent wallet with Arbitrum Sepolia ETH. The agent EOA pays gas for delegated actions; Orcus does not top it up." : "Your owner EOA pays Arbitrum Sepolia gas; approvals and the trade are separate transactions, not an atomic batch.", "Quote expiry is checked before signing and broadcast. Ostium's native call does not include a transaction deadline.", ...(agent ? ["Native delegation has no onchain expiry or per-asset/notional caps. Orcus enforces its limits before signing; the raw delegate has broader collateral and fee authority."] : [])] };
  inspectPreparedOstiumAction(prepared, agent ? "agent" : "owner");
  return prepared;
  } catch (error) { throw error instanceof EngineError ? error : new EngineError("OSTIUM_PREPARATION_FAILED", "The native action could not be prepared safely. No signature or transaction was submitted.", 503); }
}

export async function submitOstiumAgentAction(prepared: PreparedAction, account: TradingAccount, privateKey: string, options?: { assertAuthority?: (fresh?: PreparedAction) => void | Promise<void>; onSubmitted?: (evidence: { transactionHash: string; step?: "trade" }) => Promise<void> }): Promise<SubmissionResult> {
  let journalAttempted = false;
  try {
  assertOstiumAccount(account);
  const checked = inspectPreparedOstiumAction(prepared, "agent");
  if (!options?.onSubmitted || !options.assertAuthority) throw new EngineError("DURABLE_SUBMISSION_REQUIRED", "A durable action journal and fresh authority check are required before agent signing.", 503);
  const signer = privateKeyToAccount(privateKey as Hex);
  if (!account.agentAddress || !same(signer.address, account.agentAddress) || account.status !== "authorized" || account.controlRevision !== prepared.controlRevision || checked.ostium.ownerOnly) throw new EngineError("AGENT_NOT_AUTHORIZED", "The current agent is not authorized for this action.", 403);
  const rpc = await verifiedOstiumRpc(), grant = await getOstiumAuthorization({ trader: account.address, chainId: account.chainId });
  if (!same(grant.delegate, signer.address)) throw new EngineError("AGENT_NOT_AUTHORIZED", "The native Ostium delegate changed or was revoked.", 403);
  const rebuilt = await prepareOstiumAction(prepared.request, account);
  if (rebuilt.ostium.positionId !== checked.ostium.positionId || rebuilt.ostium.positionIndex !== checked.ostium.positionIndex || rebuilt.ostium.positionSize !== checked.ostium.positionSize || rebuilt.ostium.orderIndex !== checked.ostium.orderIndex) throw new EngineError("STALE_ACTION", "The native Ostium position or order identity changed before signing.", 409);
  await options.assertAuthority(rebuilt);
  inspectPreparedOstiumAction(prepared, "agent");
  const call = prepared.transactions!.at(-1)!;
  const wallet = createWalletClient({ account: signer, chain: arbitrumSepolia, transport: http(ostiumRpcUrl(), { timeout: 10_000, retryCount: 0 }) });
  const [nonce, gas, fees] = await Promise.all([rpc.getTransactionCount({ address: signer.address, blockTag: "pending" }), rpc.estimateGas({ account: signer.address, to: getAddress(call.to), data: call.data as Hex, value: 0n }), rpc.estimateFeesPerGas()]);
  await options.assertAuthority();
  const beforeSign = await getOstiumAuthorization({ trader: account.address, chainId: account.chainId });
  if (!same(beforeSign.delegate, signer.address)) throw new EngineError("AGENT_NOT_AUTHORIZED", "The native delegate changed before signing.", 403);
  if (prepared.expiresAt <= Date.now()) throw new EngineError("QUOTE_EXPIRED", "The reviewed Ostium action expired before signing.");
  const serialized = await wallet.signTransaction({ account: signer, chain: arbitrumSepolia, to: getAddress(call.to), data: call.data as Hex, value: 0n, nonce, gas, ...fees });
  const hash = keccak256(serialized);
  journalAttempted = true;
  await options.onSubmitted({ transactionHash: hash, step: "trade" });
  await options.assertAuthority();
  if (prepared.expiresAt <= Date.now()) return { status: "submitted-unknown", txHash: hash, evidence: { broadcast: "not-attempted", reason: "expired-after-journal" } };
  const beforeBroadcast = await getOstiumAuthorization({ trader: account.address, chainId: account.chainId });
  if (!same(beforeBroadcast.delegate, signer.address)) return { status: "submitted-unknown", txHash: hash, evidence: { broadcast: "not-attempted", reason: "native-delegate-changed-after-journal" } };
  try {
    const sent = await rpc.sendRawTransaction({ serializedTransaction: serialized });
    if (sent !== hash) return { status: "submitted-unknown", txHash: hash };
  } catch { return { status: "submitted-unknown", txHash: hash, evidence: { broadcast: "unknown", neverReplay: true } }; }
  return { status: "pending", txHash: hash, evidence: { broadcast: "acknowledged", settlement: "oracle-callback-pending" } };
  } catch (error) {
    const failure = error instanceof EngineError ? error : new EngineError("OSTIUM_EXECUTION_UNAVAILABLE", "The native action could not be completed. Check its recorded activity before retrying.", 503);
    if (!journalAttempted) throw Object.assign(failure, { phase: "not-submitted" as const });
    throw failure;
  }
}
