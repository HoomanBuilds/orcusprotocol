import { decodeFunctionData, erc20Abi, formatUnits, getAddress, parseUnits } from "viem";
import { z } from "zod";
import type { ActionApprovalStep, EvmTransaction, OstiumAllowanceIntent, User } from "@orcus/core";
import { addressSchema } from "@orcus/core";
import { callEngine } from "./engine";
import { ApiError } from "./errors";
import { tokenHash, type Store } from "./store";
import type { StoredAccount, StoredAction, StoredRecord } from "./types";

type Intent=OstiumAllowanceIntent&StoredRecord&{fingerprint:string};
const amountSchema=z.string().regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/).refine(value=>parseUnits(value,6)>0n&&parseUnits(value,6)<=2_000_000_000_000n,"Approve an exact positive USDC amount no greater than 2,000,000");
const transactionSchema=z.object({to:addressSchema,data:z.string().regex(/^0x(?:[\da-fA-F]{2})+$/),value:z.literal("0"),chainId:z.literal(421614),label:z.string().optional()}).strict();
const planSchema=z.object({trader:addressSchema,chainId:z.literal(421614),token:addressSchema,spender:addressSchema,amountUsd:z.string(),amountRaw:z.string().regex(/^\d+$/),transaction:transactionSchema,expiresAt:z.number().int().positive(),minimumBlock:z.string().regex(/^[1-9]\d*$/)}).passthrough();
const hashSchema=z.string().regex(/^0x[\da-fA-F]{64}$/);
const same=(first:string,second:string)=>getAddress(first)===getAddress(second);

function account(store:Store,user:User,accountId:string){
  const selected=store.get<StoredAccount>(user.id,"account",accountId);
  if(!selected||selected.venue!=="ostium"||selected.chainId!==421614||!same(selected.ownerAddress,user.address)||!same(selected.address,user.address))throw new ApiError("OSTIUM_ACCOUNT_MISMATCH","Select your owner-controlled Ostium Arbitrum Sepolia account.",403);
  return selected;
}
function read(store:Store,user:User,intentId:string){const intent=store.get<Intent>(user.id,"ostium-allowance",intentId);if(!intent)throw new ApiError("ALLOWANCE_NOT_FOUND","This allowance request does not belong to the signed-in wallet.",404);return intent;}
function publicIntent({userId,fingerprint,...intent}:Intent):OstiumAllowanceIntent{return intent;}
function parseApproval(transaction:EvmTransaction,token:string,spender:string,amountRaw:string){
  try{const decoded=decodeFunctionData({abi:erc20Abi,data:transaction.data as`0x${string}`});if(decoded.functionName!=="approve"||!same(transaction.to,token)||!same(String(decoded.args[0]),spender)||decoded.args[1]!==BigInt(amountRaw)||transaction.chainId!==421614||BigInt(transaction.value)!==0n)throw new Error();}
  catch{throw new ApiError("ALLOWANCE_PLAN_INVALID","The SDK did not provide the exact reviewed USDC approval.",503);}
}
function claimProof(store:Store,userId:string,transactionHash:string,intentId:string){
  const proofId=`ostium-approval-proof:421614:${transactionHash.toLowerCase()}`,existing=store.db.prepare("SELECT body FROM records WHERE id=?").get(proofId)as{body:string}|undefined;
  if(existing&&JSON.parse(existing.body).intentId!==intentId)throw new ApiError("ALLOWANCE_PROOF_REPLAY","This approval transaction already belongs to another recorded step.",409);
  const now=Date.now();store.put("ostium-approval-proof",{id:proofId,userId,intentId,transactionHash,createdAt:now,updatedAt:now});
}

export function listOstiumAllowances(store:Store,user:User){return{intents:store.list<Intent>(user.id,"ostium-allowance",50).map(publicIntent)};}
export async function prepareOstiumAllowance(store:Store,user:User,input:unknown){
  const data=z.object({accountId:z.string().min(1).max(100),amountUsd:amountSchema,requestId:z.string().min(1).max(100)}).strict().parse(input),selected=account(store,user,data.accountId);
  const amountRaw=parseUnits(data.amountUsd,6).toString(),amountUsd=formatUnits(BigInt(amountRaw),6),fingerprint=tokenHash(JSON.stringify([data.accountId,amountRaw])),recordId=`ostium-allowance:${tokenHash(JSON.stringify([user.id,data.requestId]))}`;
  const previous=store.get<Intent>(user.id,"ostium-allowance",recordId);
  if(previous){if(previous.fingerprint!==fingerprint)throw new ApiError("IDEMPOTENCY_CONFLICT","This approval request ID already belongs to a different account or amount.",409);return{intent:publicIntent(previous)};}
  const now=Date.now(),parsed=planSchema.safeParse(await callEngine("getOstiumApprovalTransaction",selected,amountUsd));
  if(!parsed.success||!same(parsed.data.trader,user.address)||parsed.data.amountRaw!==amountRaw||parsed.data.expiresAt<=Date.now())throw new ApiError("ALLOWANCE_PLAN_INVALID","A fresh exact owner-only USDC approval plan is unavailable.",503);
  parseApproval(parsed.data.transaction,parsed.data.token,parsed.data.spender,amountRaw);
  return store.db.transaction(()=>{
    const replay=store.get<Intent>(user.id,"ostium-allowance",recordId);if(replay){if(replay.fingerprint!==fingerprint)throw new ApiError("IDEMPOTENCY_CONFLICT","This approval request ID changed.",409);return{intent:publicIntent(replay)};}
    const pending=store.list<Intent>(user.id,"ostium-allowance",200).find(intent=>intent.accountId===selected.id&&(["submitting","pending","submitted-unknown"].includes(intent.status)||intent.status==="prepared"&&intent.expiresAt>Date.now()));
    if(pending)throw new ApiError("ALLOWANCE_PENDING","Review and reconcile the existing approval before opening another wallet request.",409);
    const intent:Intent={id:recordId,userId:user.id,accountId:selected.id,trader:user.address,chainId:421614,token:parsed.data.token,spender:parsed.data.spender,amountUsd,amountRaw,transaction:parsed.data.transaction,expiresAt:Math.min(parsed.data.expiresAt,now+300_000),notBefore:now,minimumBlock:parsed.data.minimumBlock,status:"prepared",fingerprint,createdAt:now,updatedAt:now};
    store.put("ostium-allowance",intent);return{intent:publicIntent(intent)};
  }).immediate();
}
export function submitOstiumAllowance(store:Store,user:User,intentId:string,transactionHash?:string){
  return store.db.transaction(()=>{
    const intent=read(store,user,intentId);account(store,user,intent.accountId);
    if(transactionHash)hashSchema.parse(transactionHash);
    if(intent.transactionHash&&transactionHash&&intent.transactionHash.toLowerCase()!==transactionHash.toLowerCase())throw new ApiError("EVIDENCE_CONFLICT","This approval already has a different transaction hash.",409);
    if(intent.status==="confirmed"||intent.status==="rejected")return{intent:publicIntent(intent)};
    if(!transactionHash&&intent.status!=="prepared")throw new ApiError("ALLOWANCE_PENDING","This wallet flow already started or was cancelled. Recover its evidence instead of opening it again.",409);
    if(!transactionHash&&intent.expiresAt<=Date.now())throw new ApiError("ALLOWANCE_EXPIRED","This unsigned approval quote expired. Do not open a new wallet flow from it.",409);
    const updated=store.update<Intent>(user.id,"ostium-allowance",intent.id,{status:transactionHash?"pending":"submitting",transactionHash:transactionHash??intent.transactionHash,error:undefined});
    return{intent:publicIntent(updated)};
  }).immediate();
}
export async function reconcileOstiumAllowance(store:Store,user:User,intentId:string,transactionHash?:string){
  if(transactionHash)submitOstiumAllowance(store,user,intentId,transactionHash);
  const intent=read(store,user,intentId),selected=account(store,user,intent.accountId);
  if(["confirmed","rejected"].includes(intent.status))return{intent:publicIntent(intent)};
  if(!intent.transactionHash)throw new ApiError("ALLOWANCE_HASH_REQUIRED","Check your owner wallet for this approval's hash. No signature or approval will be repeated automatically.",409);
  let result:{status?:string;transactionHash?:string;evidence?:unknown};
  try{result=await callEngine("reconcileOstiumApproval",{transactionHash:intent.transactionHash,account:selected,amountUsd:intent.amountUsd,expectedTransaction:intent.transaction,notBefore:intent.notBefore,minimumBlock:intent.minimumBlock});}
  catch{throw new ApiError("ALLOWANCE_UNVERIFIED","The approval receipt could not be verified. Keep the existing request; do not repeat it.",503);}
  if(!["pending","confirmed","rejected"].includes(result.status??"")||result.transactionHash?.toLowerCase()!==intent.transactionHash.toLowerCase())throw new ApiError("ALLOWANCE_UNVERIFIED","The adapter returned no matching approval receipt.",503);
  return store.db.transaction(()=>{
    const current=read(store,user,intentId);
    if(current.status==="confirmed"||current.status==="rejected")return{intent:publicIntent(current)};
    if(current.transactionHash?.toLowerCase()!==intent.transactionHash!.toLowerCase())throw new ApiError("EVIDENCE_CONFLICT","Approval evidence changed during reconciliation.",409);
    if(result.status==="confirmed")claimProof(store,user.id,intent.transactionHash!,intent.id);
    const updated=store.update<Intent>(user.id,"ostium-allowance",intent.id,{status:result.status as"pending"|"confirmed"|"rejected",error:result.status==="rejected"?"The owner approval transaction was rejected or reverted.":undefined});
    return{intent:publicIntent(updated)};
  }).immediate();
}
export function cancelOstiumAllowance(store:Store,user:User,intentId:string,ownerRejected=false){
  return store.db.transaction(()=>{
    const intent=read(store,user,intentId);
    if(ownerRejected&&intent.status==="submitting"&&!intent.transactionHash)return{intent:publicIntent(store.update<Intent>(user.id,"ostium-allowance",intent.id,{status:"rejected",error:"The owner declined the wallet request before signing."}))};
    if(intent.status!=="prepared")throw new ApiError("ALLOWANCE_PENDING","A started approval must be reconciled, not silently cancelled or repeated.",409);
    return{intent:publicIntent(store.update<Intent>(user.id,"ostium-allowance",intent.id,{status:"cancelled"}))};
  }).immediate();
}

function approvalStep(action:StoredAction,index:number){
  const transaction=action.prepared.transactions?.[index];
  if(!Number.isSafeInteger(index)||index<0||index>4||!transaction||transaction.chainId!==421614||!action.prepared.ostium)throw new ApiError("ALLOWANCE_STEP_INVALID","Choose an actual approval step from this owner's reviewed action.",403);
  try{
    const decoded=decodeFunctionData({abi:erc20Abi,data:transaction.data as`0x${string}`});
    if(decoded.functionName!=="approve"||BigInt(transaction.value)!==0n||(decoded.args[1]as bigint)>parseUnits(action.prepared.ostium.requiredAllowanceUsd,6))throw new Error();
    return{transaction,amountUsd:formatUnits(decoded.args[1]as bigint,6),token:transaction.to,spender:String(decoded.args[0])};
  }catch{throw new ApiError("ALLOWANCE_STEP_INVALID","This step is not an exact reviewed owner token approval.",403);}
}

export async function recordOstiumActionApproval(store:Store,user:User,action:StoredAction,index:number,transactionHash:string){
  const selected=account(store,user,action.accountId),{transaction,amountUsd,token,spender}=approvalStep(action,index);hashSchema.parse(transactionHash);
  const previous=action.approvals?.find(step=>step.index===index);
  if(previous?.transactionHash&&previous.transactionHash.toLowerCase()!==transactionHash.toLowerCase())throw new ApiError("EVIDENCE_CONFLICT","This approval step already has another transaction hash.",409);
  if(previous?.status==="confirmed")return action;
  const entry:ActionApprovalStep={index,transactionHash,amountUsd,token,spender,status:"pending",updatedAt:Date.now()};
  const merge=(step:ActionApprovalStep)=>{const current=store.get<StoredAction>(user.id,"action",action.id)!,existing=current.approvals?.find(item=>item.index===index);if(existing?.transactionHash&&existing.transactionHash.toLowerCase()!==transactionHash.toLowerCase())throw new ApiError("EVIDENCE_CONFLICT","This owner approval step already has another recorded transaction.",409);if(existing?.status==="confirmed")return current;return store.update<StoredAction>(user.id,"action",action.id,{approvals:[...(current.approvals??[]).filter(item=>item.index!==index),step],error:step.status==="rejected"?"The owner approval reverted. No native trade was submitted.":undefined});};
  merge(entry);
  const result=await callEngine<{status?:string;transactionHash?:string}>("reconcileOstiumApproval",{transactionHash,account:selected,amountUsd,expectedTransaction:transaction,notBefore:action.createdAt,minimumBlock:action.prepared.ostium!.minimumBlock});
  if(!["pending","confirmed","rejected"].includes(result.status??"")||result.transactionHash?.toLowerCase()!==transactionHash.toLowerCase())throw new ApiError("ALLOWANCE_UNVERIFIED","This approval step has no verified receipt.",503);
  return store.db.transaction(()=>{if(result.status==="confirmed")claimProof(store,user.id,transactionHash,`${action.id}:approval:${index}`);return merge({...entry,status:result.status as ActionApprovalStep["status"],updatedAt:Date.now()});}).immediate();
}

export function recordUnknownOstiumApproval(store:Store,user:User,action:StoredAction,index:number){
  account(store,user,action.accountId);
  const {amountUsd,token,spender}=approvalStep(action,index);
  const previous=action.approvals?.find(step=>step.index===index);
  if(previous?.transactionHash||previous?.status==="confirmed")return action;
  const step:ActionApprovalStep={index,amountUsd,token,spender,status:"submitted-unknown",updatedAt:Date.now()};
  return store.update<StoredAction>(user.id,"action",action.id,{approvals:[...(action.approvals??[]).filter(item=>item.index!==index),step],error:"An owner approval has an unknown wallet result. Recover its transaction hash before resuming; no token approval or trade was repeated."});
}

export function startOstiumActionApproval(store:Store,user:User,action:StoredAction,index:number){
  account(store,user,action.accountId);
  const {amountUsd,token,spender}=approvalStep(action,index),previous=action.approvals?.find(step=>step.index===index);
  if(action.expiresAt<=Date.now())throw new ApiError("QUOTE_EXPIRED","This unsigned action expired. Do not open a wallet request from it.",409);
  if(previous&&previous.status!=="rejected")throw new ApiError("ALLOWANCE_PENDING","This owner approval already started. Reconcile the existing wallet result instead of repeating it.",409);
  if(action.approvals?.some(step=>step.index!==index&&["submitting","pending","submitted-unknown"].includes(step.status)))throw new ApiError("ALLOWANCE_PENDING","Resolve the earlier owner approval before another wallet request.",409);
  const step:ActionApprovalStep={index,amountUsd,token,spender,status:"submitting",updatedAt:Date.now()};
  return store.update<StoredAction>(user.id,"action",action.id,{approvals:[...(action.approvals??[]).filter(item=>item.index!==index),step],error:undefined});
}

export function rejectOstiumActionApproval(store:Store,user:User,action:StoredAction,index:number){
  account(store,user,action.accountId);
  const previous=action.approvals?.find(step=>step.index===index);
  if(!previous||previous.status!=="submitting"||previous.transactionHash)throw new ApiError("ALLOWANCE_PENDING","Only an unsigned wallet request with a definitive owner rejection can be dismissed.",409);
  return store.update<StoredAction>(user.id,"action",action.id,{approvals:action.approvals!.map(step=>step.index===index?{...step,status:"rejected",updatedAt:Date.now()}:step),error:"The owner declined the token approval before signing."});
}
