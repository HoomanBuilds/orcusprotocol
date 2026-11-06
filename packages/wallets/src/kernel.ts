import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy, toGasPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { addressToEmptyAccount, createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createPublicClient, encodeAbiParameters, getAddress, http, padHex, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const atoms = z.string().regex(/^[1-9]\d{0,76}$/);
export const kernelGrantPolicySchema = z.object({
  accountAddress: address,
  agentAddress: address,
  router: address,
  swaps: z.array(z.object({ tokenIn: address, tokenOut: address, feeTier: z.union([z.literal(100), z.literal(500), z.literal(3000), z.literal(10000)]), maxAmountIn: atoms, minAmountOut: atoms }).strict()).min(1).max(8),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  maxGasWei: atoms,
  nativeWrap: z.object({weth:address,maxAmountWei:atoms}).strict().optional(),
}).strict().refine(policy => policy.expiresAt > policy.issuedAt && policy.expiresAt - policy.issuedAt <= 86_400_000, "Permission must expire within 24 hours");
export type KernelGrantPolicy = z.infer<typeof kernelGrantPolicySchema>;
export interface KernelAuthorization { approval: string; policy: KernelGrantPolicy }
export interface KernelConfig { rpcUrl: string; bundlerUrl: string }

export const entryPoint = getEntryPoint("0.7");
export const kernelVersion = KERNEL_V3_1;
export const swapSelector = toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))");
export const multicallSelector = toFunctionSelector("multicall(uint256,bytes[])");

export function kernelPublicClient(config: Pick<KernelConfig, "rpcUrl">) {
  return createPublicClient({ chain: sepolia, transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 0 }) });
}

export function buildKernelPolicies(input: KernelGrantPolicy) {
  const policy = kernelGrantPolicySchema.parse(input);
  const word = (value: bigint | number | string): Hex => typeof value === "string" && value.startsWith("0x") ? padHex(value as Hex, { size: 32 }) : toHex(BigInt(value), { size: 32 });
  const rule = (offset: number, value: bigint | number | string, condition = ParamCondition.EQUAL) => ({ offset, params: [word(value)], condition });
  const permissions = policy.swaps.flatMap(swap => {
    const tokenWord = encodeAbiParameters([{ type: "address" }], [getAddress(swap.tokenIn)]);
    // Fix the outer ABI layout and single inner call before checking its fields.
    const selectorWord = `${swapSelector}${tokenWord.slice(2, 58)}` as Hex;
    return [
      {
        target: getAddress(swap.tokenIn), selector: toFunctionSelector("approve(address,uint256)"), valueLimit: 0n,
        rules: [rule(0, policy.router), rule(32, BigInt(swap.maxAmountIn), ParamCondition.LESS_THAN_OR_EQUAL)],
      },
      {
        target: getAddress(policy.router), selector: multicallSelector, valueLimit: 0n,
        rules: [
          rule(0, Math.floor(policy.expiresAt / 1000), ParamCondition.LESS_THAN_OR_EQUAL),
          rule(32, 64), rule(64, 1), rule(96, 32), rule(128, 228),
          { offset: 160, params: [selectorWord], condition: ParamCondition.EQUAL },
          rule(164, swap.tokenIn), rule(196, swap.tokenOut), rule(228, swap.feeTier), rule(260, policy.accountAddress),
          rule(292, BigInt(swap.maxAmountIn), ParamCondition.LESS_THAN_OR_EQUAL),
          rule(292, 0, ParamCondition.GREATER_THAN),
          rule(324, BigInt(swap.minAmountOut), ParamCondition.GREATER_THAN_OR_EQUAL), rule(356, 0),
        ],
      },
    ];
  });
  if(policy.nativeWrap){
    if(!policy.swaps.some(swap=>getAddress(swap.tokenIn)===getAddress(policy.nativeWrap!.weth)&&BigInt(swap.maxAmountIn)>=BigInt(policy.nativeWrap!.maxAmountWei)))throw new Error("The native wrapping cap must fit an approved WETH input band.");
    permissions.push({target:getAddress(policy.nativeWrap.weth),selector:toFunctionSelector("deposit()"),valueLimit:BigInt(policy.nativeWrap.maxAmountWei),rules:[]});
  }
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions }),
    toTimestampPolicy({ validAfter: Math.floor(policy.issuedAt / 1000), validUntil: Math.floor(policy.expiresAt / 1000) }),
    toGasPolicy({ allowed: BigInt(policy.maxGasWei) }),
  ];
}

export async function createOwnerKernel(config: KernelConfig, owner: Parameters<typeof signerToEcdsaValidator>[1]["signer"] | Address) {
  const publicClient = kernelPublicClient(config);
  const signer = typeof owner === "string" ? addressToEmptyAccount(owner) : owner;
  const sudo = await signerToEcdsaValidator(publicClient, { entryPoint, kernelVersion, signer });
  const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo } });
  const client = createKernelAccountClient({ account, chain: sepolia, client: publicClient, bundlerTransport: http(config.bundlerUrl, { retryCount: 0, timeout: 30_000 }) });
  return { publicClient, account, client, sudo };
}

export async function createPermissionPlugin(config: KernelConfig, policy: KernelGrantPolicy) {
  const publicClient = kernelPublicClient(config);
  const signer = await toECDSASigner({ signer: addressToEmptyAccount(getAddress(policy.agentAddress)) });
  return toPermissionValidator(publicClient, { entryPoint, kernelVersion, signer, policies: buildKernelPolicies(policy) });
}
