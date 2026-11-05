import { randomUUID } from "node:crypto";
import { createPublicClient, encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, http, isAddressEqual, parseAbi, zeroAddress } from "viem";
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
  const baseToken = symbol.startsWith("USDC") ? cfg.usdc : cfg.weth;
  const quoteToken = symbol.startsWith("USDC") ? cfg.weth : cfg.usdc;
  const inputDefault = action.side === "buy" ? quoteToken : baseToken;
  const outputDefault = action.side === "buy" ? baseToken : quoteToken;
  const tokenIn = getAddress(action.tokenIn ?? inputDefault);
  const tokenOut = getAddress(action.tokenOut ?? outputDefault);
  if (isAddressEqual(tokenIn, tokenOut)) throw new EngineError("SAME_TOKEN", "Choose two different swap assets.");
  const supported = [cfg.weth, cfg.usdc].map(a => a.toLowerCase());
  if (![tokenIn, tokenOut].every(a => supported.includes(a.toLowerCase()))) throw new EngineError("UNSUPPORTED_TOKEN", "This build supports verified Sepolia WETH and USDC for swaps.");
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
  if (action.accountId !== account.id) throw new EngineError("ACCOUNT_MISMATCH", "The action does not belong to this trading account.");
  if (action.type !== "swap") throw new EngineError("UNSUPPORTED_ACTION", "Use a spot swap for Uniswap; perpetual orders belong to Hyperliquid.");
  const cfg = engineConfig().uniswap;
  const { rpc, tokenIn, tokenOut, inputDecimals, outputDecimals, amountIn } = await quoteTokens(action);
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
  if (allowance < amountIn) {
    if (allowance > 0n) transactions.push({ to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.router, 0n] }), value: "0", chainId: cfg.chainId, label: "Reset existing token allowance" });
    transactions.push({ to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.router, amountIn] }), value: "0", chainId: cfg.chainId, label: `Approve exactly ${action.amount} ${isAddressEqual(tokenIn, getAddress(cfg.weth)) ? "WETH" : "USDC"}` });
  }
  transactions.push({ to: cfg.router, data: calldata, value: "0", chainId: cfg.chainId, label: "Swap on Uniswap V3 with bounded output and deadline" });
  return { id: randomUUID(), request: { ...action, tokenIn, tokenOut, tokenInDecimals: inputDecimals, tokenOutDecimals: outputDecimals, feeTier: fee }, account, kind: account.smartAccountAddress ? "user-operation" : "evm", transactions, quote: { amountIn: action.amount, amountOut: formatUnits(amountOut, outputDecimals), minimumOut: formatUnits(minimumOut, outputDecimals), fee: `${fee / 10_000}%`, observedAt: Date.now() }, expiresAt, controlRevision: account.controlRevision, warnings: ["Sepolia tokens have no monetary value. Testnet pool prices do not represent live market prices.", `Quoted gas estimate: ${gas.toString()} units.`, ...(account.smartAccountAddress ? [] : ["This is owner-only execution. Agent swaps require a funded, permissioned smart account."])] };
}

export async function getUniswapMarkets(): Promise<Market[]> {
  const cfg = engineConfig().uniswap;
  const rpc = await verifiedClient();
  const amountIn = 10n ** 18n;
  const { result } = await rpc.simulateContract({ address: cfg.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: cfg.weth, tokenOut: cfg.usdc, amountIn, fee: 500, sqrtPriceLimitX96: 0n }] });
  return [{ venue: "uniswap", symbol: "WETH/USDC", baseAsset: "WETH", quoteAsset: "USDC", midPrice: formatUnits(result[0], 6), observedAt: Date.now() }];
}

export async function reconcileUniswapAction(action: { transactionHash?: string; txHash?: string }, account: TradingAccount): Promise<SubmissionResult> {
  assertAccount(account);
  const hash = action.transactionHash ?? action.txHash;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { status: "submitted-unknown" };
  const rpc = await verifiedClient();
  try {
    const receipt = await rpc.getTransactionReceipt({ hash: hash as `0x${string}` });
    const tx = await rpc.getTransaction({ hash: hash as `0x${string}` });
    if (!account.smartAccountAddress && !isAddressEqual(tx.from, getAddress(account.address))) throw new EngineError("TRANSACTION_ACCOUNT_MISMATCH", "The transaction was not sent by this trading account.");
    return { status: receipt.status === "success" ? "confirmed" : "rejected", txHash: hash, evidence: { blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), confirmationsRequired: 1 } };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return { status: "pending", txHash: hash };
  }
}
