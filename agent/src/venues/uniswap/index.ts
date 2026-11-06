import { randomUUID } from "node:crypto";
import { createPublicClient, decodeEventLog, encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, http, isAddressEqual, parseAbi, zeroAddress, type Hex } from "viem";
import { entryPoint } from "@orcus/wallets/kernel";
import { sepolia } from "viem/chains";
import { tradeRequestSchema, type Market, type PreparedAction, type TradingAccount, type TradeRequest } from "@orcus/core";
import { engineConfig } from "../../config";
import { EngineError } from "../../errors";
import type { AccountPortfolio, SubmissionResult } from "../../types";
import { decimalToAtoms } from "../hyperliquid/wire-format";

const factoryAbi = parseAbi(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
]);
const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
const wethAbi = parseAbi(["function deposit() payable"]);

function client() { return createPublicClient({ chain: sepolia, transport: http(engineConfig().uniswap.rpcUrl, { timeout: 15_000, retryCount: 1 }) }); }

async function verifiedClient() {
  const rpc = client();
  const cfg = engineConfig().uniswap;
  if (await rpc.getChainId() !== cfg.chainId) throw new EngineError("WRONG_NETWORK", "The configured RPC is not Ethereum Sepolia.");
  return rpc;
}

function assertAccount(account: TradingAccount) {
  if (account.venue !== "uniswap" || account.chainId !== 11155111) throw new EngineError("WRONG_NETWORK", "Uniswap actions are limited to Ethereum Sepolia in this build.");
  getAddress(account.address);
  if (account.smartAccountAddress && !isAddressEqual(getAddress(account.address), getAddress(account.smartAccountAddress))) throw new EngineError("ACCOUNT_MISMATCH", "The trading address must match the configured smart account.");
}

export async function getUniswapPortfolio(account: TradingAccount): Promise<AccountPortfolio> {
  assertAccount(account);
  const cfg = engineConfig().uniswap;
  const rpc = await verifiedClient();
  const address = getAddress(account.address);
  const eth = await rpc.getBalance({ address });
  const tokens = [{ symbol: "WETH", address: cfg.weth, decimals: 18 }, { symbol: "USDC", address: cfg.usdc, decimals: 6 }];
  const errors: string[] = [];
  const balances = [{ accountId: account.id, symbol: "ETH", amount: formatEther(eth), decimals: 18 }];
  for (const token of tokens) {
    try {
      const amount = await rpc.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      balances.push({ accountId: account.id, symbol: token.symbol, amount: formatUnits(amount, token.decimals), decimals: token.decimals, ...{ tokenAddress: token.address } });
    } catch { errors.push(`Could not load ${token.symbol} balance.`); }
  }
  return { accountId: account.id, balances, positions: [], orders: [], observedAt: Date.now(), errors: errors.length ? errors : undefined };
}

async function quoteTokens(action: TradeRequest) {
  const cfg = engineConfig().uniswap;
  const symbol = action.symbol.toUpperCase();
  if (symbol !== "WETH/USDC") throw new EngineError("UNSUPPORTED_MARKET", "This Sepolia spot integration supports only WETH/USDC. Native ETH input requires its explicit wrap option.");
  const inputDefault = action.side === "buy" ? cfg.usdc : cfg.weth;
  const outputDefault = action.side === "buy" ? cfg.weth : cfg.usdc;
  const tokenIn = getAddress(action.tokenIn ?? inputDefault);
  const tokenOut = getAddress(action.tokenOut ?? outputDefault);
  if(action.nativeInput&&(!isAddressEqual(tokenIn,cfg.weth)||!isAddressEqual(tokenOut,cfg.usdc)))throw new EngineError("NATIVE_INPUT_PAIR_UNSUPPORTED","Native ETH input must wrap the verified WETH token and swap into USDC.");
  if (isAddressEqual(tokenIn, tokenOut)) throw new EngineError("SAME_TOKEN", "Choose two different swap assets.");
  const supported = [cfg.weth, cfg.usdc].map(a => a.toLowerCase());
  if (![tokenIn, tokenOut].every(a => supported.includes(a.toLowerCase()))) throw new EngineError("UNSUPPORTED_TOKEN", "This build supports verified Sepolia WETH and USDC for swaps.");
  if (!isAddressEqual(tokenIn, inputDefault) || !isAddressEqual(tokenOut, outputDefault)) throw new EngineError("TOKEN_DIRECTION_MISMATCH", "The explicit tokens contradict the reviewed WETH/USDC buy or sell direction.");
  const rpc = await verifiedClient();
  const [inputDecimals, outputDecimals] = await Promise.all([
    rpc.readContract({ address: tokenIn, abi: erc20Abi, functionName: "decimals" }),
    rpc.readContract({ address: tokenOut, abi: erc20Abi, functionName: "decimals" }),
  ]);
  if (action.tokenInDecimals !== undefined && action.tokenInDecimals !== inputDecimals || action.tokenOutDecimals !== undefined && action.tokenOutDecimals !== outputDecimals) throw new EngineError("TOKEN_DECIMALS_MISMATCH", "Token precision changed or does not match the selected token.");
  const amountIn = decimalToAtoms(action.amount, inputDecimals);
  if (amountIn <= 0n || amountIn > 2n ** 256n - 1n) throw new EngineError("INVALID_AMOUNT", "Swap amount is outside the supported token range.");
  return { rpc, tokenIn, tokenOut, inputDecimals, outputDecimals, amountIn };
}

export async function prepareUniswapAction(input: TradeRequest, account: TradingAccount): Promise<PreparedAction> {
  const action = tradeRequestSchema.parse(input);
  assertAccount(account);
  if(action.nativeInput&&!account.smartAccountAddress)throw new EngineError("NATIVE_INPUT_ACCOUNT_REQUIRED","Atomic native ETH swaps require your smart trading account. Create and fund it, or wrap ETH separately before a WETH swap.");
  if (action.accountId !== account.id) throw new EngineError("ACCOUNT_MISMATCH", "The action does not belong to this trading account.");
  if (action.type !== "swap") throw new EngineError("UNSUPPORTED_ACTION", "Use a spot swap for Uniswap; perpetual orders belong to Hyperliquid.");
  const cfg = engineConfig().uniswap;
  const { rpc, tokenIn, tokenOut, inputDecimals, outputDecimals, amountIn } = await quoteTokens(action);
  if(action.nativeInput&&inputDecimals!==18)throw new EngineError("NATIVE_WRAPPER_PRECISION","The verified native ETH wrapper must use 18 decimals.");
  if(action.nativeInput&&await rpc.getBalance({address:getAddress(account.address)})<amountIn)throw new EngineError("INSUFFICIENT_NATIVE_BALANCE","The trading account does not have enough native Sepolia ETH for this exact wrap amount. Keep gas funds unless the operation is sponsored.",402);
  const fee = action.feeTier ?? 500;
  const [pool, routerCode, quoterCode] = await Promise.all([
    rpc.readContract({ address: cfg.factory, abi: factoryAbi, functionName: "getPool", args: [tokenIn, tokenOut, fee] }),
    rpc.getCode({ address: cfg.router }), rpc.getCode({ address: cfg.quoter }),
  ]);
  if (pool === zeroAddress) throw new EngineError("NO_POOL", "No pool exists for this token pair and fee tier. Try another supported fee tier.");
  if (!routerCode || routerCode === "0x" || !quoterCode || quoterCode === "0x") throw new EngineError("MISSING_DEPLOYMENT", "The configured protocol contracts are not deployed on this network.", 503);
  let amountOut: bigint, gas: bigint;
  try {
    const { result } = await rpc.simulateContract({ address: cfg.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
    amountOut = result[0]; gas = result[3];
  } catch { throw new EngineError("QUOTE_UNAVAILABLE", "This Sepolia pool cannot quote the requested size. Check liquidity or lower the amount.", 422); }
  const minimumOut = amountOut * BigInt(10_000 - action.slippageBps) / 10_000n;
  if (minimumOut <= 0n) throw new EngineError("DUST_SWAP", "The quoted output is too small for a protected swap.");
  const expiresAt = Date.now() + 60_000;
  const swapData = encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut, fee, recipient: getAddress(account.address), amountIn, amountOutMinimum: minimumOut, sqrtPriceLimitX96: 0n }] });
  const calldata = encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [BigInt(Math.floor(expiresAt / 1000)), [swapData]] });
  const allowance = await rpc.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [getAddress(account.address), cfg.router] });
  const transactions: NonNullable<PreparedAction["transactions"]> = [];
  if(action.nativeInput)transactions.push({to:tokenIn,data:encodeFunctionData({abi:wethAbi,functionName:"deposit"}),value:amountIn.toString(),chainId:cfg.chainId,label:`Wrap exactly ${action.amount} ETH into WETH`});
  if (allowance < amountIn) {
    if (allowance > 0n) transactions.push({ to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.router, 0n] }), value: "0", chainId: cfg.chainId, label: "Reset existing token allowance" });
    transactions.push({ to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.router, amountIn] }), value: "0", chainId: cfg.chainId, label: `Approve exactly ${action.amount} ${isAddressEqual(tokenIn, getAddress(cfg.weth)) ? "WETH" : "USDC"}` });
  }
  transactions.push({ to: cfg.router, data: calldata, value: "0", chainId: cfg.chainId, label: "Swap on Uniswap V3 with bounded output and deadline" });
  return { id: randomUUID(), request: { ...action, tokenIn, tokenOut, tokenInDecimals: inputDecimals, tokenOutDecimals: outputDecimals, feeTier: fee }, account, kind: account.smartAccountAddress ? "user-operation" : "evm", transactions, quote: { amountIn: action.amount, amountOut: formatUnits(amountOut, outputDecimals), minimumOut: formatUnits(minimumOut, outputDecimals), fee: `${fee / 10_000}%`, observedAt: Date.now() }, expiresAt, controlRevision: account.controlRevision, warnings: ["Sepolia tokens have no monetary value. Testnet pool prices do not represent live market prices.", `Quoted gas estimate: ${gas.toString()} units.`, ...(action.nativeInput?["Native ETH is wrapped and swapped in one atomic account batch. Output is USDC. Gas requires separate ETH unless sponsorship succeeds."]:[]), ...(account.smartAccountAddress ? [] : ["This is owner-only execution. Agent swaps require a funded, permissioned smart account."])] };
}

export async function getUniswapMarkets(): Promise<Market[]> {
  const cfg = engineConfig().uniswap;
  const rpc = await verifiedClient();
  const amountIn = 10n ** 18n;
  const { result } = await rpc.simulateContract({ address: cfg.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: cfg.weth, tokenOut: cfg.usdc, amountIn, fee: 500, sqrtPriceLimitX96: 0n }] });
  return [{ venue: "uniswap", symbol: "WETH/USDC", baseAsset: "WETH", quoteAsset: "USDC", midPrice: formatUnits(result[0], 6), observedAt: Date.now() }];
}

const operationEventAbi = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)"]);
const transferEventAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const depositEventAbi = parseAbi(["event Deposit(address indexed dst,uint256 wad)"]);
interface SettlementLog { address: string; data: Hex; topics: readonly Hex[] }
export interface SwapReconciliationInput { transactionHash?: string; txHash?: string; userOperationHash?: string; prepared?: PreparedAction }

export function verifySwapSettlement(action: SwapReconciliationInput, account: TradingAccount, transaction: { from: string; to: string | null; input: Hex }, logs: readonly SettlementLog[]) {
  const prepared = action.prepared;
  if (!prepared?.request.tokenIn || !prepared.request.tokenOut || !prepared.quote?.minimumOut || prepared.request.tokenInDecimals === undefined || prepared.request.tokenOutDecimals === undefined) throw new EngineError("SETTLEMENT_CONTEXT_MISSING", "A prepared quote is required to verify the actual swap settlement.");
  let operationLogs = logs;
  if (account.smartAccountAddress) {
    if (!transaction.to || !isAddressEqual(getAddress(transaction.to), entryPoint.address)) throw new EngineError("TRANSACTION_ACCOUNT_MISMATCH", "The transaction did not use the expected account-abstraction EntryPoint.");
    let start = 0;
    const matches: Array<{ success: boolean; logs: readonly SettlementLog[] }> = [];
    for (let index = 0; index < logs.length; index++) {
      const log = logs[index];
      if (!isAddressEqual(getAddress(log.address), entryPoint.address)) continue;
      try {
        const event = decodeEventLog({ abi: operationEventAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (isAddressEqual(event.args.sender, getAddress(account.address)) && (!action.userOperationHash || event.args.userOpHash.toLowerCase() === action.userOperationHash.toLowerCase())) matches.push({ success: event.args.success, logs: logs.slice(start, index) });
        start = index + 1;
      } catch { continue; }
    }
    if (matches.length !== 1) throw new EngineError("USER_OPERATION_NOT_VERIFIED", "The receipt does not uniquely identify this account's user operation.");
    if (!matches[0].success) return false;
    operationLogs = matches[0].logs;
  } else {
    const swap = prepared.transactions?.at(-1);
    if (!swap || !isAddressEqual(getAddress(transaction.from), getAddress(account.address)) || !transaction.to || !isAddressEqual(getAddress(transaction.to), getAddress(swap.to)) || transaction.input.toLowerCase() !== swap.data.toLowerCase()) throw new EngineError("TRANSACTION_ACCOUNT_MISMATCH", "The transaction does not match the prepared owner swap.");
  }
  const input = getAddress(prepared.request.tokenIn), output = getAddress(prepared.request.tokenOut), owner = getAddress(account.address);
  const amountIn = decimalToAtoms(prepared.quote.amountIn, prepared.request.tokenInDecimals);
  const minimumOut = decimalToAtoms(prepared.quote.minimumOut, prepared.request.tokenOutDecimals);
  let spent = 0n, received = 0n,wrapped = 0n;
  for (const log of operationLogs) {
    if (!isAddressEqual(getAddress(log.address), input) && !isAddressEqual(getAddress(log.address), output)) continue;
    if(prepared.request.nativeInput&&isAddressEqual(getAddress(log.address),input)){
      try{const event=decodeEventLog({abi:depositEventAbi,data:log.data,topics:log.topics as[Hex,...Hex[]]});if(isAddressEqual(event.args.dst,owner))wrapped+=event.args.wad;}catch{}
    }
    try {
      const event = decodeEventLog({ abi: transferEventAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (isAddressEqual(getAddress(log.address), input) && isAddressEqual(event.args.from, owner)) spent += event.args.value;
      if (isAddressEqual(getAddress(log.address), output) && isAddressEqual(event.args.to, owner)) received += event.args.value;
    } catch { continue; }
  }
  if (spent !== amountIn || received < minimumOut) throw new EngineError("SWAP_SETTLEMENT_NOT_VERIFIED", "The receipt does not prove the quoted input and protected output for this account.");
  if(prepared.request.nativeInput&&(!account.smartAccountAddress||wrapped!==amountIn))throw new EngineError("NATIVE_WRAP_NOT_VERIFIED","The same account operation must prove the exact native ETH deposit as well as its protected swap output.");
  return true;
}

export async function reconcileUniswapAction(action: SwapReconciliationInput, account: TradingAccount): Promise<SubmissionResult> {
  assertAccount(account);
  const hash = action.transactionHash ?? action.txHash;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { status: "submitted-unknown" };
  const rpc = await verifiedClient();
  try {
    const receipt = await rpc.getTransactionReceipt({ hash: hash as `0x${string}` });
    const tx = await rpc.getTransaction({ hash: hash as `0x${string}` });
    const success = receipt.status === "success" && verifySwapSettlement(action, account, tx, receipt.logs);
    return { status: success ? "confirmed" : "rejected", txHash: hash, evidence: { blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), confirmationsRequired: 1, userOperationHash: action.userOperationHash, swapTransfersVerified: success } };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return { status: "pending", txHash: hash };
  }
}
