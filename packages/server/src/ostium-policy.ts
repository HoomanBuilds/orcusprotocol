import { getAddress } from "viem";
import { z } from "zod";
import { addressSchema, decimalSchema, ostiumDelegationAcknowledgementSchema, type PreparedAction, type TradeRequest } from "@orcus/core";
import { callEngine } from "./engine";
import { ApiError } from "./errors";
import type { StoredAccount, StoredPermission } from "./types";

const nativeAuthorizationSchema=z.object({trader:addressSchema,delegate:addressSchema,chainId:z.literal(421614),contractAddress:addressSchema,implementation:addressSchema,observedAt:z.number().int().positive()}).passthrough();
const executionSchema=z.object({trader:addressSchema,recipient:addressSchema,chainId:z.literal(421614),pairId:z.number().int().nonnegative(),symbol:z.string().min(1).max(50),amountUnit:z.enum(["base","collateral-usdc"]),requiredAllowanceUsd:decimalSchema,collateralUsd:decimalSchema,notionalUsd:decimalSchema,leverage:z.number().finite().min(1).max(1000),builderFeeBps:z.literal(0),marketObservedAt:z.number().int().positive(),minimumBlock:z.string().regex(/^\d+$/),functionName:z.string().min(1).max(100),expectedData:z.string().regex(/^0x(?:[\da-fA-F]{2}){4,}$/),positionId:z.string().optional(),delegate:addressSchema.optional(),ownerOnly:z.boolean().optional()}).passthrough();
export const ostiumAgentActions=["market","limit","stop","cancel","reduce","close","stop-loss","take-profit","edit-order","add-collateral"]as const;

function sameAddress(first:string,second:string){return getAddress(first)===getAddress(second);}
function usdMicros(value:string){const[whole,fraction=""]=value.split(".");return BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,"0").slice(0,6))+(fraction.slice(6).match(/[1-9]/)?1n:0n);}

export async function ostiumAuthorization(account:StoredAccount,expectedAgent?:string){
  if(account.venue!=="ostium"||account.chainId!==421614||!sameAddress(account.address,account.ownerAddress))throw new ApiError("OSTIUM_ACCOUNT_MISMATCH","Use the connected owner account on Ostium Arbitrum Sepolia.",403);
  const parsed=nativeAuthorizationSchema.safeParse(await callEngine("getOstiumAuthorization",{trader:account.ownerAddress,chainId:421614}));
  if(!parsed.success||!sameAddress(parsed.data.trader,account.ownerAddress)||parsed.data.observedAt<Date.now()-30_000||parsed.data.observedAt>Date.now()+5_000)throw new ApiError("OSTIUM_AUTHORITY_UNVERIFIED","A fresh source-verified Ostium native delegation observation is required.",503);
  if(expectedAgent&&!sameAddress(parsed.data.delegate,expectedAgent))throw new ApiError("AGENT_NOT_APPROVED","The current Ostium owner delegation does not authorize this agent.",403);
  return parsed.data;
}

export function ostiumAcknowledgement(account:StoredAccount,agentAddress:string,authorization:unknown){
  const input=z.object({ostiumAcknowledgement:ostiumDelegationAcknowledgementSchema,transactionHash:z.string().regex(/^0x[\da-fA-F]{64}$/).optional()}).strict().safeParse(authorization);
  if(!input.success||!sameAddress(input.data.ostiumAcknowledgement.trader,account.ownerAddress)||!sameAddress(input.data.ostiumAcknowledgement.agentAddress,agentAddress))throw new ApiError("OSTIUM_ACKNOWLEDGEMENT_REQUIRED","Explicitly acknowledge the native delegate's broader rights, lack of onchain expiry and application-only limits before activating it.",403);
  return input.data;
}

export function validateOstiumExecution(prepared:PreparedAction,account:StoredAccount,permission?:StoredPermission){
  const parsed=executionSchema.safeParse(prepared.ostium);
  if(!parsed.success)throw new ApiError("OSTIUM_EXECUTION_UNVERIFIED","The Ostium adapter did not provide bounded native execution evidence.",503);
  const details=parsed.data,request=prepared.request;
  if(account.venue!=="ostium"||account.chainId!==421614||request.venue!=="ostium"||request.accountId!==account.id||prepared.kind!=="evm"||!sameAddress(details.trader,account.ownerAddress)||!sameAddress(details.recipient,account.ownerAddress)||details.symbol!==request.symbol||details.marketObservedAt<Date.now()-30_000||details.marketObservedAt>Date.now()+5_000||request.positionId&&details.positionId!==request.positionId)throw new ApiError("OSTIUM_EXECUTION_MISMATCH","The native trader, recipient, market, position or observation does not match this reviewed account.",403);
  if(request.amountUnit&&details.amountUnit!==request.amountUnit)throw new ApiError("OSTIUM_AMOUNT_UNIT_MISMATCH","Review the explicit collateral or base-asset amount units before signing.",403);
  if(request.mode==="agent"&&(request.type==="remove-collateral"||details.ownerOnly))throw new ApiError("OWNER_SIGNATURE_REQUIRED","Collateral removal and other owner-only actions require the owner's wallet.",403);
  if(permission){
    if(!details.delegate||!sameAddress(details.delegate,permission.agentAddress))throw new ApiError("OSTIUM_DELEGATE_MISMATCH","The prepared native action does not bind the authorized agent.",403);
    ostiumAcknowledgement(account,permission.agentAddress,permission.authorization);
    if(details.leverage>(permission.maxLeverage??20))throw new ApiError("LEVERAGE_LIMIT","The actual Ostium position or order leverage exceeds this agent's application cap.",403);
    if(usdMicros(details.requiredAllowanceUsd)>usdMicros(permission.maxCollateralUsd??permission.maxTradeUsd)||usdMicros(details.collateralUsd)>usdMicros(permission.maxCollateralUsd??permission.maxTradeUsd))throw new ApiError("COLLATERAL_LIMIT","The actual owner collateral exceeds this agent's application cap.",403);
    if(request.type!=="cancel"&&usdMicros(details.notionalUsd)>usdMicros(permission.maxTradeUsd))throw new ApiError("TRADE_LIMIT","The actual native action notional exceeds this agent's application cap.",403);
  }
  if(["market","limit","stop"].includes(request.type)&&request.leverage!==details.leverage)throw new ApiError("OSTIUM_LEVERAGE_MISMATCH","The native entry leverage differs from the reviewed request.",403);
  return details;
}
