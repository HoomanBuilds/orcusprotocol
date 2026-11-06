import { encodeOperatorPaymasterData, operatorPaymasterAbi, operatorSponsorshipTypedData, type OperatorUserOperation } from "@orcus/wallets/operator-paymaster";
import { entryPoint } from "@orcus/wallets/kernel";
import { assertSponsoredOperation } from "@orcus/wallets/gas";
import { decodeFunctionResult, encodeFunctionData, getAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi } from "viem/account-abstraction";
import { z } from "zod";
import { ApiError } from "./errors";
import { gasSponsorConfig } from "./sponsorship-config";

const quantity = z.string().max(34).regex(/^0x[\da-fA-F]+$/);
const estimateSchema = z.object({ callGasLimit: quantity, verificationGasLimit: quantity, preVerificationGas: quantity, paymasterVerificationGasLimit: quantity.optional(), paymasterPostOpGasLimit: quantity.optional() }).passthrough();
const dummySignature = `0x${"ff".repeat(65)}` as Hex;
const gasFields = ["callGasLimit", "verificationGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"] as const;
type Operation = { sender: string; nonce: string; callData: string; factory?: string; factoryData?: string; signature?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string } & Partial<Record<typeof gasFields[number], string>>;

async function rpc(url: string, method: string, params: unknown[]) {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (text.length > 100_000) throw new Error();
    const body = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (body.error || body.result === undefined) throw new Error();
    return body.result;
  } catch { throw new ApiError("SPONSORSHIP_UNAVAILABLE", "The configured operator sponsorship infrastructure could not complete a read or gas estimate. No alternate provider was used.", 503); }
}

export async function sponsorWithOperator(operation: Operation, capWei: string, consume: boolean) {
  const cfg = gasSponsorConfig();
  if (cfg.provider !== "operator" || !cfg.configured || !cfg.privateKey || !cfg.paymaster || !cfg.bundlerUrl) throw new ApiError("SPONSORSHIP_UNCONFIGURED", "Configure the operator signer, paymaster and bundler before sponsored trading.", 503);
  const signer = privateKeyToAccount(cfg.privateKey), paymaster = cfg.paymaster;
  const [chainId, bundlerChainId, paymasterCode, entryPointCode, supported] = await Promise.all([
    rpc(cfg.rpcUrl, "eth_chainId", []), rpc(cfg.bundlerUrl, "eth_chainId", []),
    rpc(cfg.rpcUrl, "eth_getCode", [paymaster, "latest"]), rpc(cfg.rpcUrl, "eth_getCode", [entryPoint.address, "latest"]),
    rpc(cfg.bundlerUrl, "eth_supportedEntryPoints", []),
  ]);
  if (chainId !== "0xaa36a7" || bundlerChainId !== "0xaa36a7") throw new ApiError("SPONSORSHIP_WRONG_NETWORK", "Operator sponsorship is only supported on Ethereum Sepolia.", 503);
  const deployed = (value: unknown) => typeof value === "string" && /^0x(?:[\da-fA-F]{2})+$/.test(value) && !/^0x0+$/.test(value);
  if (!deployed(paymasterCode) || !deployed(entryPointCode)) throw new ApiError("SPONSORSHIP_PAYMASTER_UNDEPLOYED", "The operator paymaster and EntryPoint must be deployed on Sepolia.", 503);
  if (!Array.isArray(supported) || !supported.some(value => typeof value === "string" && value.toLowerCase() === entryPoint.address.toLowerCase())) throw new ApiError("SPONSORSHIP_ENTRYPOINT_MISMATCH", "The selected bundler does not support EntryPoint v0.7.", 503);
  const read = async (functionName: "entryPoint" | "verifyingSigner" | "maxOperationCostWei" | "getDeposit") => {
    const result = await rpc(cfg.rpcUrl, "eth_call", [{ to: paymaster, data: encodeFunctionData({ abi: operatorPaymasterAbi, functionName }) }, "latest"]);
    try { return decodeFunctionResult({ abi: operatorPaymasterAbi, functionName, data: result as Hex }); }
    catch { throw new ApiError("SPONSORSHIP_PAYMASTER_INVALID", "The deployed paymaster does not expose the expected operator sponsorship interface.", 503); }
  };
  const [configuredEntryPoint, configuredSigner, contractCap, deposit] = await Promise.all([read("entryPoint"), read("verifyingSigner"), read("maxOperationCostWei"), read("getDeposit")]);
  if (getAddress(configuredEntryPoint as Address) !== getAddress(entryPoint.address) || getAddress(configuredSigner as Address) !== getAddress(signer.address)) throw new ApiError("SPONSORSHIP_PAYMASTER_MISMATCH", "The deployed paymaster EntryPoint or authorized operator signer does not match this server.", 503);
  if (typeof contractCap !== "bigint" || typeof deposit !== "bigint" || contractCap <= 0n || deposit <= 0n) throw new ApiError("SPONSORSHIP_UNFUNDED", "The operator paymaster needs a funded Sepolia EntryPoint deposit and a positive gas cap.", 503);
  const rawDepositInfo = await rpc(cfg.rpcUrl, "eth_call", [{ to: entryPoint.address, data: encodeFunctionData({ abi: entryPoint07Abi, functionName: "getDepositInfo", args: [paymaster] }) }, "latest"]);
  let depositInfo: ReturnType<typeof decodeDepositInfo>;
  try { depositInfo = decodeDepositInfo(rawDepositInfo as Hex); }
  catch { throw new ApiError("SPONSORSHIP_PAYMASTER_INVALID", "EntryPoint stake and deposit information could not be verified.", 503); }
  if (depositInfo.deposit !== deposit) throw new ApiError("SPONSORSHIP_UNFUNDED", "The paymaster-reported deposit does not match its actual EntryPoint deposit.", 503);
  const policy = cfg.stakePolicy;
  if (policy.required && (!depositInfo.staked || depositInfo.stake === 0n || depositInfo.withdrawTime !== 0 || depositInfo.unstakeDelaySec < policy.minimumUnstakeDelaySeconds || policy.minimumStakeWei !== undefined && depositInfo.stake < BigInt(policy.minimumStakeWei))) throw new ApiError("SPONSORSHIP_STAKE_REQUIRED", "The operator paymaster needs a locked EntryPoint stake matching this bundler's configured amount and unstake-delay policy. Gas deposit alone is not sufficient.", 503);
  if (!operation.maxFeePerGas || !operation.maxPriorityFeePerGas || BigInt(operation.maxFeePerGas) <= 0n || BigInt(operation.maxPriorityFeePerGas) > BigInt(operation.maxFeePerGas)) throw new ApiError("SPONSORSHIP_REJECTED", "Provide a positive bounded fee quote before requesting sponsored gas.", 403);
  if (!operation.signature || operation.signature === "0x") throw new ApiError("SPONSORSHIP_REJECTED", "A smart-account signature stub is required for gas estimation.", 403);
  const validAfter = Math.max(0, Math.floor(Date.now() / 1000) - 5), validUntil = Math.floor(Date.now() / 1000) + 120;
  const maxCostWei = BigInt(capWei) < contractCap ? BigInt(capWei) : contractCap;
  const authorization = { paymaster, entryPoint: entryPoint.address, chainId: 11155111, validAfter, validUntil, maxCostWei, paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 0n };
  const estimateInput = {
    ...operation, callGasLimit: operation.callGasLimit ?? "0x0", verificationGasLimit: operation.verificationGasLimit ?? "0x0", preVerificationGas: operation.preVerificationGas ?? "0x0",
    paymaster, paymasterVerificationGasLimit: toHex(authorization.paymasterVerificationGasLimit), paymasterPostOpGasLimit: "0x0", paymasterData: encodeOperatorPaymasterData(authorization, dummySignature),
  };
  const parsed = estimateSchema.safeParse(await rpc(cfg.bundlerUrl, "eth_estimateUserOperationGas", [estimateInput, entryPoint.address]));
  if (!parsed.success) throw new ApiError("SPONSORSHIP_REJECTED", "The bundler did not return valid bounded operation gas estimates.", 502);
  const max = (first: string | undefined, second: string) => toHex(BigInt(first ?? "0x0") > BigInt(second) ? BigInt(first!) : BigInt(second));
  const estimates = parsed.data;
  const result = {
    paymaster, paymasterData: estimateInput.paymasterData,
    callGasLimit: max(operation.callGasLimit, estimates.callGasLimit),
    verificationGasLimit: max(operation.verificationGasLimit, estimates.verificationGasLimit),
    preVerificationGas: max(operation.preVerificationGas, toHex(BigInt(estimates.preVerificationGas) + 4096n)),
    paymasterVerificationGasLimit: max(estimates.paymasterVerificationGasLimit, toHex(authorization.paymasterVerificationGasLimit)),
    paymasterPostOpGasLimit: max(estimates.paymasterPostOpGasLimit, "0x0"),
    maxFeePerGas: operation.maxFeePerGas, maxPriorityFeePerGas: operation.maxPriorityFeePerGas,
  };
  const exact = { ...operation, ...result }, cost = assertSponsoredOperation(exact, capWei);
  if (cost > contractCap || cost > deposit) throw new ApiError("SPONSORSHIP_UNFUNDED", "The operator paymaster deposit or onchain cap cannot cover this operation.", 402);
  const finalAuthorization = { ...authorization, maxCostWei: cost, paymasterVerificationGasLimit: BigInt(result.paymasterVerificationGasLimit), paymasterPostOpGasLimit: BigInt(result.paymasterPostOpGasLimit) };
  const typedOperation: OperatorUserOperation = {
    sender: getAddress(exact.sender), nonce: BigInt(exact.nonce), callData: exact.callData as Hex,
    ...(exact.factory ? { factory: getAddress(exact.factory), factoryData: exact.factoryData as Hex } : {}),
    verificationGasLimit: BigInt(result.verificationGasLimit), callGasLimit: BigInt(result.callGasLimit), preVerificationGas: BigInt(result.preVerificationGas),
    maxFeePerGas: BigInt(result.maxFeePerGas), maxPriorityFeePerGas: BigInt(result.maxPriorityFeePerGas),
  };
  result.paymasterData = encodeOperatorPaymasterData(finalAuthorization, consume ? await signer.signTypedData(operatorSponsorshipTypedData(typedOperation, finalAuthorization)) : dummySignature);
  return { result, depositWei: deposit, paymaster, validUntil, staking: { required: policy.required, staked: depositInfo.staked, stakeWei: depositInfo.stake.toString(), unstakeDelaySeconds: depositInfo.unstakeDelaySec, configuredMinimumStakeWei: policy.minimumStakeWei, admissionVerified: false } };
}

function decodeDepositInfo(data: Hex) {
  return decodeFunctionResult({ abi: entryPoint07Abi, functionName: "getDepositInfo", data });
}
