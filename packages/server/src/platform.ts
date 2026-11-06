import { createHash } from "node:crypto";
import { formatUnits, getAddress, parseUnits } from "viem";
import type { KernelGrantPolicy } from "@orcus/wallets/kernel";
import { automationInputSchema,automationUpdateSchema,automationMarketMatches,tradeRequestSchema,venueSchema,OSTIUM_DELEGATION_NOTICE,type AutomationInput,type AutomationUpdate,type PreparedAction,type TradeRequest,type User,type Portfolio,type Market,type HealthStatus } from "@orcus/core";
import { z } from "zod";
import { getBudget,setBudget } from "./budget";
import { assertComputeFundingAuthority,cancelComputeFunding,configureComputeFunding,getComputeFundingPolicy,prepareComputeFunding,recordComputeFundingSubmission,settleComputeFunding } from "./compute-funding";
import type { ComputeFundingResult } from "@orcus/engine/budget";
import { callEngine } from "./engine";
import { ApiError,errorMessage } from "./errors";
import { createSigner,memoryKey,readSigner } from "./keystore";
import { getStore,id,type Store } from "./store";
import type { Document,StoredAccount,StoredAction,StoredAgent,StoredAgentRequest,StoredAutomation,StoredEvaluationRun,StoredMessage,StoredPermission } from "./types";
import { AgentMemoryStore,rejectMemorySecrets } from "./memory";
import { AgentRun,readAgentRunStatus } from "./agent-runtime";
import { listStorageExpenses,recordStorageExpense } from "./storage-expenses";
import { safeAgentToolSteps } from "./agent-evidence";
import { selectedAgentModel } from "./agent-models";
import { selectStoragePayer,assertStoragePayerAllowance,publicStoragePayerMetadata } from "./storage-payer";
import { agentRequestSchema,agentRequestRecordId,agentRequestLease,agentRequestView,chatRequestFingerprint,chatRequestReference,listAgentRequests,queuedAgentRequests,readAgentRequest,recoverInterruptedAgentRequests,safeAgentRequestError,storedAgentRequest } from "./agent-requests";
import { assertOstiumAutomation,ostiumAcknowledgement,ostiumAgentActions,ostiumAuthorization,validateOstiumExecution } from "./ostium-policy";
import { recordOstiumActionApproval,recordUnknownOstiumApproval,rejectOstiumActionApproval,startOstiumActionApproval } from "./ostium-allowances";

export const accountSchema=z.object({venue:venueSchema,address:z.string().optional(),smartAccountAddress:z.string().optional(),chainId:z.number().int().optional(),label:z.string().max(80).optional()}).strict();
export const automationSchema=automationInputSchema;
const terminalStates=new Set(["confirmed","rejected","cancelled"]);
const evaluationSchema=z.object({id:z.string(),automationId:z.string(),accountId:z.string(),chainId:z.number().int(),decision:z.enum(["allow","reject","no-action"]),reason:z.string(),source:z.literal("local-simulation"),observedAt:z.number().int(),expiresAt:z.number().int(),controlRevision:z.number().int(),policyVersion:z.number().int(),requestId:z.string().optional()}).passthrough();
type AgentReply={modelId?:string;message:string;proposal?:TradeRequest;automationProposal?:unknown;requestId?:string;requestIds?:string[];modelCalls?:number;usage?:unknown;costUsd?:string;requiresClarification?:boolean;privacy?:StoredMessage["privacy"];privacyEvidence?:unknown;toolTrace?:unknown};

export class Platform {
  constructor(readonly store:Store=getStore()){}
  agent(user:User):StoredAgent {
    const existing=this.store.list<StoredAgent>(user.id,"agent")[0];if(existing)return existing;
    const operating=createSigner(this.store,user.id,"operating");
    return this.store.put("agent",{id:id(),userId:user.id,name:"My Orcus Agent",operatingAddress:operating.address,paused:false,mode:"approval-required",preferences:"",privateInferenceRequired:false,controlRevision:0,createdAt:Date.now(),updatedAt:Date.now()});
  }
  accounts(user:User){return this.store.list<StoredAccount>(user.id,"account");}
  account(user:User,accountId:string){const account=this.store.get<StoredAccount>(user.id,"account",accountId);if(!account)throw new ApiError("ACCOUNT_NOT_FOUND","Connect this trading account first.",404);return account;}
  expirePermissions(user:User){
    this.store.db.transaction(()=>{
      const permissions=this.store.list<StoredPermission>(user.id,"permission"),expired=new Set<string>();
      for(const permission of permissions)if(["pending","active"].includes(permission.status)&&permission.expiresAt<=Date.now()){this.store.update<StoredPermission>(user.id,"permission",permission.id,{status:"expired"});expired.add(permission.accountId);}
      for(const accountId of expired){const account=this.account(user,accountId);if(account.status==="authorized"&&!permissions.some(permission=>permission.accountId===accountId&&permission.status==="active"&&permission.expiresAt>Date.now()))this.store.update<StoredAccount>(user.id,"account",accountId,{status:"connected"});}
    }).immediate();
  }
  session(user:User){this.expirePermissions(user);return {user,agent:this.agent(user),accounts:this.accounts(user)};}
  agentState(user:User){this.expirePermissions(user);return {agent:this.agent(user),messages:this.store.list<StoredMessage>(user.id,"message").reverse(),permissions:this.store.list<StoredPermission>(user.id,"permission").map(({authorization,...permission})=>permission)};}
  plannerPermissions(user:User){
    this.expirePermissions(user);
    const accounts=this.accounts(user);
    return this.store.list<StoredPermission>(user.id,"permission").filter(permission=>permission.status==="active"&&permission.expiresAt>Date.now()).map(permission=>{
      const account=accounts.find(item=>item.id===permission.accountId);
      return{id:permission.id,accountId:permission.accountId,venue:account?.venue,allowedActions:permission.allowedActions,allowedSymbols:permission.allowedSymbols,maxTradeUsd:permission.maxTradeUsd,maxCollateralUsd:permission.maxCollateralUsd,maxLeverage:permission.maxLeverage,nativeAuthority:account?.venue==="ostium"?OSTIUM_DELEGATION_NOTICE:undefined,expiresAt:permission.expiresAt,enforcement:permission.enforcement,controlRevision:permission.controlRevision,...(permission.policy?{onchain:{kind:"kernel-fixed-output-bands",router:permission.policy.router,recipient:permission.policy.accountAddress,nativeWrap:permission.policy.nativeWrap,swaps:permission.policy.swaps.map(swap=>({tokenIn:swap.tokenIn,tokenOut:swap.tokenOut,feeTier:swap.feeTier,maximumInputAtoms:swap.maxAmountIn,minimumOutputAtoms:swap.minAmountOut})),limitation:"Each permitted input cap has a fixed minimum output floor. A smaller input may be outside the band even below the USD cap. Propose an exact permitted amount when appropriate or ask the owner to regrant; never lower the minimum output or claim arbitrary up-to-cap amounts are executable."}}:{})};
    });
  }
  createAccount(user:User,input:unknown){
    const data=accountSchema.parse(input),address=getAddress(data.smartAccountAddress??data.address??user.address),chainId=data.chainId??(data.venue==="uniswap"?11155111:421614);
    if(chainId!==(data.venue==="uniswap"?11155111:421614))throw new ApiError("UNSUPPORTED_NETWORK","Only configured Sepolia, Hyperliquid testnet and Ostium Arbitrum Sepolia accounts are supported.");
    if(data.venue!=="uniswap"&&address.toLowerCase()!==user.address.toLowerCase())throw new ApiError("OWNER_MISMATCH","Use the connected owner address for this venue.");
    const existing=this.accounts(user).find(account=>account.venue===data.venue&&account.address.toLowerCase()===address.toLowerCase());if(existing)return existing;
    const accountId=id(),signer=createSigner(this.store,user.id,`trading:${accountId}`);
    return this.store.put("account",{id:accountId,userId:user.id,venue:data.venue,address,ownerAddress:user.address,chainId,label:data.label??(data.venue==="uniswap"?"Uniswap Sepolia":data.venue==="ostium"?"Ostium Arbitrum Sepolia":"Hyperliquid Testnet"),agentAddress:signer.address,...(data.venue==="uniswap"&&address.toLowerCase()!==user.address.toLowerCase()?{smartAccountAddress:address}:{}),status:"connected",controlRevision:0,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredAccount);
  }
  async portfolio(user:User):Promise<Portfolio>{
    const accounts=this.accounts(user),balances:Portfolio["balances"]=[],positions:Portfolio["positions"]=[],orders:Portfolio["orders"]=[],errors:NonNullable<Portfolio["errors"]>=[];
    const valuations=new Map<string,bigint>(),observations:number[]=[];
    await Promise.all(accounts.map(async account=>{try{
      const portfolio=await callEngine<{balances?:Portfolio["balances"];positions?:Portfolio["positions"];orders?:Portfolio["orders"];equityUsd?:string;observedAt?:number;errors?:Array<string|{message:string}>}>("getPortfolio",account);
      balances.push(...(portfolio.balances??[]));positions.push(...(portfolio.positions??[]));orders.push(...(portfolio.orders??[]));
      errors.push(...(portfolio.errors??[]).map(error=>({accountId:account.id,message:typeof error==="string"?error:error.message})));
      if(typeof portfolio.observedAt==="number"&&Number.isFinite(portfolio.observedAt))observations.push(portfolio.observedAt);
      if(typeof portfolio.equityUsd==="string"&&/^-?\d+(?:\.\d{1,18})?$/.test(portfolio.equityUsd)){
        const negative=portfolio.equityUsd.startsWith("-"),[whole,fraction=""]=portfolio.equityUsd.replace(/^-/,'').split(".");
        valuations.set(account.id,(negative?-1n:1n)*(BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,"0").slice(0,6))));
      }
    }catch(error){errors.push({accountId:account.id,message:errorMessage(error)});}}));
    const totalEquityUsd=accounts.length>0&&valuations.size===accounts.length&&errors.length===0?formatUnits([...valuations.values()].reduce((sum,value)=>sum+value,0n),6):undefined;
    return {accounts,balances,positions,orders,totalEquityUsd,observedAt:observations.length?Math.min(...observations):Date.now(),errors};
  }
  control(user:User,input:{modelId?:string;command:string;mode?:"approval-required"|"autonomous";preferences?:string;privateInferenceRequired?:boolean;privateVerification?:"independent-gateway"|"gateway-reported"}){
    const agent=this.agent(user);if(!["pause","resume","take-over","update"].includes(input.command))throw new ApiError("INVALID_CONTROL","Use pause, resume, take-over or update.");
    const modelId=input.modelId===undefined?agent.modelId:selectedAgentModel(input.modelId),modelOnly=input.command==="update"&&input.modelId!==undefined&&Object.keys(input).every(key=>["command","modelId"].includes(key));
    const paused=input.command==="pause"||input.command==="take-over"?true:input.command==="resume"?false:agent.paused;
    return this.store.db.transaction(()=>{
      const updated=this.store.update<StoredAgent>(user.id,"agent",agent.id,{modelId,paused,mode:input.mode??agent.mode,preferences:input.preferences??agent.preferences,privateInferenceRequired:input.privateInferenceRequired??agent.privateInferenceRequired,privateVerification:input.privateVerification??agent.privateVerification??"independent-gateway",controlRevision:agent.controlRevision+(modelOnly?0:1)});
      if(input.preferences!==undefined){
        const memory=new AgentMemoryStore(this.store,user.id);
        for(const row of this.store.db.prepare("SELECT id FROM agent_memories WHERE user_id=? AND source='profile' AND source_id=?").all(user.id,agent.id)as{id:string}[])memory.forget(row.id);
        if(input.preferences.trim())memory.remember({content:input.preferences,kind:"preference",importance:100},"profile",agent.id);
      }
      if(paused){for(const automation of this.store.list<StoredAutomation>(user.id,"automation"))if(automation.status==="active")this.store.update<StoredAutomation>(user.id,"automation",automation.id,{status:"paused"});for(const action of this.store.list<StoredAction>(user.id,"action"))if(["prepared","awaiting-approval"].includes(action.status)&&action.initiator!=="manual")this.store.update<StoredAction>(user.id,"action",action.id,{status:"cancelled",error:"Agent paused or owner took over before submission."});}
      return {agent:updated,inFlight:this.store.list<StoredAction>(user.id,"action").filter(action=>["submitting","submitted-unknown","pending","partially-filled"].includes(action.status))};
    })();
  }
  async budget(user:User){
    let storagePayer;
    try{storagePayer={enabled:process.env.ZEROG_STORAGE_ENABLED==="true",configured:true,...publicStoragePayerMetadata(this.store,this.memoryPayer(user))};}
    catch(error){storagePayer={enabled:false,configured:false,costBearer:process.env.ZEROG_STORAGE_PAYER==="operator"?"operator":"agent",userNeeds0G:process.env.ZEROG_STORAGE_PAYER!=="operator",message:error instanceof ApiError?error.message:"The storage payer is not configured."};}
    const funding=this.computeFunding(user),latest=funding.intents[0];
    const replenishmentStatus=funding.intents.some(intent=>["prepared","submitting","submitted-unknown"].includes(intent.status))?"pending":latest?.status==="confirmed"?"confirmed":latest?.status==="failed"?"failed":funding.status==="authorized"?"idle":"unconfigured";
    const local={...getBudget(this.store,user.id),operatingAddress:this.agent(user).operatingAddress,nativeExpenses:listStorageExpenses(this.store,user.id),storagePayer,replenishmentStatus};
    try{
      const provider=await callEngine<{status:"verified"|"unavailable"|"unconfigured";balance?:string;message:string;unit?:string;address?:string;[key:string]:unknown}>("getComputeBalance");
      return {...local,computeBalanceStatus:provider.status,providerBalance:provider,computeBalanceScope:"configured-provider-account",warning:`${local.warning} ${provider.message}`};
    }catch{return{...local,computeBalanceStatus:"unavailable"as const,warning:"Provider balance is unavailable. The authorized expense cap is not proof of funded compute credits."};}
  }
  async setBudget(user:User,input:{limitUsd?:string;capUsd?:string;lowBalanceUsd?:string;autoReplenish?:boolean}){
    const previous=getBudget(this.store,user.id);setBudget(this.store,user.id,input.limitUsd??input.capUsd??previous.limitUsd,input.lowBalanceUsd??previous.lowBalanceUsd,input.autoReplenish??previous.autoReplenish);return this.budget(user);
  }
  computeFunding(user:User){return getComputeFundingPolicy(this.store,user);}
  async setComputeFunding(user:User,input:unknown){
    const disabled=z.object({enabled:z.literal(false)}).strict().safeParse(input).success;
    return configureComputeFunding(this.store,user,input,{operatingAddress:this.agent(user).operatingAddress,providerBalance:disabled?undefined:await callEngine("getComputeBalance")});
  }
  async prepareFunding(user:User,requestId:string){
    const policy=this.computeFunding(user).policy;
    const context={operatingAddress:this.agent(user).operatingAddress,providerBalance:await callEngine("getComputeBalance"),paymentVaultBalance:policy?await callEngine("readComputeVaultBalance",policy.computeAccountAddress):undefined};
    return prepareComputeFunding(this.store,user,requestId,context);
  }
  fundingIntent(user:User,intentId:string){
    const intent=this.store.get<ReturnType<typeof getComputeFundingPolicy>["intents"][number]>(user.id,"compute-funding",intentId);
    if(!intent)throw new ApiError("NOT_FOUND","The compute funding intent does not exist.",404);
    return intent;
  }
  async reconcileFunding(user:User,intentId:string){
    return this.withAccountLease(`operating:${user.id}`,async()=>{
      const intent=this.fundingIntent(user,intentId);
      if(["confirmed","failed","cancelled"].includes(intent.status))return intent;
      if(!intent.transactionHash)throw new ApiError("FUNDING_NOT_SUBMITTED","This deposit has no signed transaction to reconcile.",409);
      return settleComputeFunding(this.store,user,intentId,await callEngine<ComputeFundingResult>("reconcileComputeFunding",intent,intent.transactionHash));
    });
  }
  cancelFunding(user:User,intentId:string){return cancelComputeFunding(this.store,user,intentId);}
  async submitFunding(user:User,intentId:string){
    return this.withAccountLease(`operating:${user.id}`,async assertLease=>{
      const intent=this.fundingIntent(user,intentId);
      if(["confirmed","failed","cancelled"].includes(intent.status))return intent;
      if(intent.transactionHash)return settleComputeFunding(this.store,user,intentId,await callEngine<ComputeFundingResult>("reconcileComputeFunding",intent,intent.transactionHash));
      const agent=this.agent(user),assertAuthority=()=>{
        assertLease();assertComputeFundingAuthority(this.store,user,intentId);
        const current=this.agent(user);
        if(current.paused||current.controlRevision!==agent.controlRevision||current.operatingAddress.toLowerCase()!==intent.payerAddress.toLowerCase())throw new ApiError("FUNDING_CONTROL_CHANGED","Agent control or its operating signer changed. No new deposit is authorized.",409);
      };
      assertAuthority();
      try{
        const result=await callEngine<ComputeFundingResult>("submitComputeFunding",intent,readSigner(this.store,user.id,"operating"),{assertAuthority,onSubmissionIntent:(hash:string)=>{assertAuthority();recordComputeFundingSubmission(this.store,user,intentId,hash);}});
        return settleComputeFunding(this.store,user,intentId,result);
      }catch(error){
        if(error&&typeof error==="object"&&"phase"in error&&error.phase==="not-submitted"){
          const evidence="evidence"in error&&error.evidence&&typeof error.evidence==="object"?error.evidence as {transactionHash?:string}:{};
          cancelComputeFunding(this.store,user,intentId,{phase:"not-submitted",transactionHash:evidence.transactionHash});
        }
        throw error;
      }
    });
  }
  async tickComputeFunding(assertTick:()=>void){
    const results:Document[]=[],processedUsers=new Set<string>();
    const pending=this.store.db.prepare("SELECT user_id,id FROM records WHERE kind='compute-funding' AND json_extract(body,'$.status') IN ('prepared','submitting','submitted-unknown') ORDER BY updated_at,id LIMIT 3").all()as{user_id:string;id:string}[];
    for(const row of pending){
      assertTick();const user=this.storedUser(row.user_id);if(!user)continue;processedUsers.add(user.id);
      try{
        let intent=this.fundingIntent(user,row.id);
        if(intent.status==="prepared"){
          try{assertComputeFundingAuthority(this.store,user,intent.id);}catch{intent=this.cancelFunding(user,intent.id);}
          if(intent.status==="prepared"){if(this.agent(user).paused)continue;intent=await this.submitFunding(user,intent.id);}
        }else intent=await this.reconcileFunding(user,intent.id);
        results.push({kind:"compute-funding",intentId:intent.id,status:intent.status});
      }catch(error){results.push({kind:"compute-funding",intentId:row.id,status:"reconciliation-pending",error:errorMessage(error)});}
    }
    const policies=this.store.db.prepare("SELECT p.user_id FROM records p LEFT JOIN records c ON c.user_id=p.user_id AND c.kind='compute-funding-check' WHERE p.kind='compute-funding-policy' AND json_extract(p.body,'$.enabled')=1 AND json_extract(p.body,'$.expiresAt')>? AND (c.id IS NULL OR json_extract(c.body,'$.nextCheckAt')<=?) ORDER BY COALESCE(c.updated_at,0),p.id LIMIT 3").all(Date.now(),Date.now())as{user_id:string}[];
    for(const row of policies){
      assertTick();const user=this.storedUser(row.user_id);if(!user)continue;
      const now=Date.now();this.store.put("compute-funding-check",{id:`compute-funding-check:${user.id}`,userId:user.id,nextCheckAt:now+60_000,createdAt:now,updatedAt:now});
      if(processedUsers.has(user.id)||this.agent(user).paused||!getBudget(this.store,user.id).autoReplenish)continue;
      try{
        const prepared=await this.prepareFunding(user,`worker:${Math.floor(now/60_000)}`);
        assertTick();
        if(prepared.status==="prepared"){const intent=await this.submitFunding(user,prepared.intent.id);results.push({kind:"compute-funding",intentId:intent.id,status:intent.status});}
        else results.push({kind:"compute-funding",status:"no-action",reason:prepared.reason});
      }catch(error){results.push({kind:"compute-funding",userId:user.id,status:"blocked",error:errorMessage(error)});}
    }
    return results;
  }
  async permission(user:User,input:{accountId:string;action:string;permissionId?:string;expiresAt?:number;maxTradeUsd?:string;maxCollateralUsd?:string;maxLeverage?:number;allowNativeInput?:boolean;allowedSymbols?:string[];allowedActions?:TradeRequest["type"][];authorization?:unknown}){
    this.expirePermissions(user);
    let account=this.account(user,input.accountId);
    if(input.action==="revoke"||input.action==="rotate"){
      const previousAgentAddress=account.agentAddress;
      for(const permission of this.store.list<StoredPermission>(user.id,"permission"))if(permission.accountId===account.id&&permission.status!=="revoked")this.store.update<StoredPermission>(user.id,"permission",permission.id,{status:"revoked"});
      const signer=input.action==="rotate"?createSigner(this.store,user.id,`trading:${account.id}`,true):undefined;
      account=this.store.update<StoredAccount>(user.id,"account",account.id,{status:"revoked",controlRevision:account.controlRevision+1,...(signer?{agentAddress:signer.address}:{})});
      if(account.venue==="ostium"){
        try{const native=await ostiumAuthorization(account),managed=new Set([previousAgentAddress,account.agentAddress,...this.store.list<StoredPermission>(user.id,"permission").filter(permission=>permission.accountId===account.id).map(permission=>permission.agentAddress)].filter(Boolean).map(address=>address!.toLowerCase())),requiresOwnerRevocation=managed.has(native.delegate.toLowerCase()),ostium=requiresOwnerRevocation?await callEngine("getOstiumDelegationTransactions",account,null):undefined;return{account,requiresOwnerRevocation,ostium,nativeAuthority:native,notice:OSTIUM_DELEGATION_NOTICE,message:"Application automation is disabled. Only the owner can change native delegation; unrelated delegates are left unchanged, and local expiry or rotation does not revoke native authority."};}
        catch{return{account,requiresOwnerRevocation:true,notice:OSTIUM_DELEGATION_NOTICE,message:"Application automation is disabled. Native revocation is unverified because Ostium authority could not be read. The owner must remove it in the venue wallet."};}
      }
      return {account,requiresOwnerRevocation:true,message:"Application automation is disabled. Revoke the signer in your venue wallet to remove its native authority."};
    }
    if(input.action==="prepare"){
      const expiresAt=input.expiresAt??Date.now()+86_400_000;if(expiresAt<=Date.now()||expiresAt>Date.now()+(account.venue==="uniswap"?1:30)*86_400_000)throw new ApiError("INVALID_EXPIRY",account.venue==="uniswap"?"Kernel permissions must expire within 24 hours.":"Choose a permission lifetime between now and 30 days.");
      const signer=createSigner(this.store,user.id,`trading:${account.id}`);
      const maxTradeUsd=input.maxTradeUsd??"100";
      if(decimalProductMicros(maxTradeUsd,"1")<=0n)throw new ApiError("INVALID_TRADE_CAP","Set a positive trade cap.");
      const supported=account.venue==="uniswap"?["swap"]:account.venue==="ostium"?[...ostiumAgentActions]:["market","limit","cancel","reduce","close","stop-loss","take-profit"];
      if(input.allowedActions?.some(action=>!supported.includes(action)))throw new ApiError("ACTION_NOT_AUTHORIZED","Choose agent actions supported by this venue. Collateral removal remains owner-only.",403);
      const maxCollateralUsd=account.venue==="ostium"?input.maxCollateralUsd??maxTradeUsd:undefined,maxLeverage=account.venue==="ostium"?input.maxLeverage??20:undefined;
      if(maxCollateralUsd!==undefined&&decimalProductMicros(maxCollateralUsd,"1")<=0n)throw new ApiError("INVALID_TRADE_CAP","Set a positive collateral cap.");
      if(maxLeverage!==undefined&&(!Number.isFinite(maxLeverage)||maxLeverage<1||maxLeverage>1000||!/^\d+(?:\.\d{1,2})?$/.test(String(maxLeverage))))throw new ApiError("INVALID_LEVERAGE","Use leverage between 1 and 1000 with at most two decimal places.");
      const native=account.venue==="ostium"?await ostiumAuthorization(account):undefined;
      if(native&&native.delegate.toLowerCase()!=="0x0000000000000000000000000000000000000000"&&native.delegate.toLowerCase()!==signer.address.toLowerCase())throw new ApiError("OSTIUM_DELEGATE_EXISTS","Another native Ostium delegate already exists. The owner must review and remove it; it will not be silently replaced.",409);
      const ostium=account.venue==="ostium"?await callEngine("getOstiumDelegationTransactions",account,signer.address):undefined;
      const policy=account.venue==="uniswap"?await this.kernelPolicy(account,signer.address,maxTradeUsd,expiresAt,input.allowNativeInput===true):undefined;
      const permission=this.store.put("permission",{id:id(),userId:user.id,accountId:account.id,agentAddress:signer.address,allowedSymbols:input.allowedSymbols??[],allowedActions:input.allowedActions??supported as TradeRequest["type"][],maxTradeUsd,maxCollateralUsd,maxLeverage,expiresAt,status:"pending",enforcement:account.venue==="uniswap"?"account":"application",controlRevision:account.controlRevision,policy,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredPermission);
      for(const previous of this.store.list<StoredPermission>(user.id,"permission"))if(previous.accountId===account.id&&previous.id!==permission.id&&previous.status==="pending")this.store.update<StoredPermission>(user.id,"permission",previous.id,{status:"revoked",supersededBy:permission.id});
      return {permission,agentAddress:signer.address,agentName:"Orcus Agent",policy,ostium,notice:account.venue==="ostium"?OSTIUM_DELEGATION_NOTICE:undefined,authorization:account.venue==="hyperliquid"?{agentAddress:signer.address,agentName:"Orcus Agent",expiresAfter:expiresAt}:undefined};
    }
    if(input.action!=="activate")throw new ApiError("INVALID_PERMISSION_ACTION","Use prepare, activate, revoke or rotate.");
    const permissions=this.store.list<StoredPermission>(user.id,"permission"),permission=permissions.find(item=>item.accountId===account.id&&item.status==="pending"&&(!input.permissionId||item.id===input.permissionId));
    if(!permission){const active=permissions.find(item=>item.accountId===account.id&&item.status==="active"&&item.expiresAt>Date.now()&&(!input.permissionId||item.id===input.permissionId));if(active&&account.status==="authorized"&&(account.venue==="hyperliquid"||canonicalJson(active.authorization)===canonicalJson(input.authorization))){if(account.venue==="ostium"){ostiumAcknowledgement(account,active.agentAddress,input.authorization);await ostiumAuthorization(account,active.agentAddress);}return{permission:{...active,authorization:undefined},account};}}
    if(!permission||permission.expiresAt<=Date.now())throw new ApiError("PERMISSION_EXPIRED","Prepare a new authorization first.");
    let nativeAuthority:StoredPermission["nativeAuthority"];
    if(account.venue==="hyperliquid")await this.verifyHyperliquidApproval(account,permission.agentAddress);
    else if(account.venue==="ostium"){ostiumAcknowledgement(account,permission.agentAddress,input.authorization);nativeAuthority=await ostiumAuthorization(account,permission.agentAddress);}
    else await this.verifyKernelApproval(account,permission,input.authorization);
    if(this.account(user,account.id).controlRevision!==permission.controlRevision)throw new ApiError("CONTROL_CHANGED","Account control changed during authorization. Prepare a new grant.",409);
    const active=this.store.update<StoredPermission>(user.id,"permission",permission.id,{status:"active",authorization:input.authorization,nativeAuthority});
    for(const previous of permissions)if(previous.accountId===account.id&&previous.id!==active.id&&previous.status==="active")this.store.update<StoredPermission>(user.id,"permission",previous.id,{status:"revoked",supersededBy:active.id});
    this.store.update<StoredAccount>(user.id,"account",account.id,{status:"authorized"});
    return {permission:{...active,authorization:undefined},account:this.account(user,account.id),message:"The new application grant supersedes earlier grants. Previously signed native authority must be revoked by the owner at the venue when no longer needed."};
  }
  async verifyHyperliquidApproval(account:StoredAccount,agentAddress:string){
    const response=await fetch("https://api.hyperliquid-testnet.xyz/info",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"extraAgents",user:account.ownerAddress}),signal:AbortSignal.timeout(12_000)});
    if(!response.ok)throw new ApiError("VENUE_UNAVAILABLE","Could not verify Hyperliquid agent approval.",503);
    const agents=await response.json() as {address?:string;validUntil?:number}[];
    if(!Array.isArray(agents)||!agents.some(agent=>agent.address?.toLowerCase()===agentAddress.toLowerCase()&&(!agent.validUntil||agent.validUntil>Date.now())))throw new ApiError("AGENT_NOT_APPROVED","Approve this agent in your Hyperliquid owner wallet first.",409);
  }
  async verifyKernelApproval(account:StoredAccount,permission:StoredPermission,authorization:unknown){
    if(!permission.policy||JSON.stringify((authorization as {policy?:unknown}|undefined)?.policy)!==JSON.stringify(permission.policy))throw new ApiError("INVALID_SESSION_POLICY","Approve the exact bounded policy prepared for this account.",403);
    const wallets=await import("@orcus/wallets/server") as unknown as Record<string,unknown>;
    if(typeof wallets.verifyKernelEnrollment!=="function")throw new ApiError("SESSION_UNCONFIGURED","Kernel permission verification is not configured. Manual trading remains available.",503);
    const valid=await (wallets.verifyKernelEnrollment as (input:unknown)=>Promise<boolean>)({ownerAddress:account.ownerAddress,smartAccountAddress:account.smartAccountAddress??account.address,agentAddress:permission.agentAddress,authorization,permission});
    if(!valid)throw new ApiError("INVALID_SESSION_APPROVAL","The permission approval does not match this owner, account and bounded signer.",403);
  }
  async kernelPolicy(account:StoredAccount,agentAddress:string,maxTradeUsd:string,expiresAt:number,allowNativeInput=false):Promise<KernelGrantPolicy>{
    if(!account.smartAccountAddress)throw new ApiError("SMART_ACCOUNT_REQUIRED","Create and fund your user-owned smart account before granting spot execution.",409);
    const cfg=await callEngine<{uniswap:{router:string;weth:string;usdc:string}}>("engineConfig");
    const markets=await callEngine<Market[]>("getMarkets","uniswap"),market=markets.find(item=>item.symbol==="WETH/USDC");
    if(!market||Date.now()-market.observedAt>30_000)throw new ApiError("STALE_MARKET","A fresh Sepolia reference quote is required for the session bounds.",409);
    const usdcAtoms=decimalProductMicros(maxTradeUsd,"1"),priceMicros=decimalProductMicros(market.midPrice,"1");
    if(priceMicros<=0n||usdcAtoms>100_000_000_000n)throw new ApiError("INVALID_TRADE_CAP","Use a positive session cap no greater than $100,000.");
    const wethAtoms=usdcAtoms*10n**18n/priceMicros;
    if(wethAtoms<=0n)throw new ApiError("DUST_PERMISSION","The session cap is too small for this pool.");
    const swaps:KernelGrantPolicy["swaps"]=[];
    for(const [tokenIn,tokenOut,maxAmountIn,decimals,side]of[[cfg.uniswap.usdc,cfg.uniswap.weth,usdcAtoms,6,"buy"],[cfg.uniswap.weth,cfg.uniswap.usdc,wethAtoms,18,"sell"]]as const){
      const request=tradeRequestSchema.parse({accountId:account.id,venue:"uniswap",type:"swap",symbol:"WETH/USDC",side,amount:formatUnits(maxAmountIn,decimals),tokenIn,tokenOut,slippageBps:50,mode:"manual",feeTier:500});
      const prepared=await callEngine<PreparedAction>("prepareAction",request,account);
      if(!prepared.quote?.minimumOut||prepared.request.tokenOutDecimals===undefined)throw new ApiError("QUOTE_UNAVAILABLE","The pool did not return usable bounded output for this session.",409);
      const minAmountOut=parseUnits(prepared.quote.minimumOut,prepared.request.tokenOutDecimals);
      if(minAmountOut<=0n)throw new ApiError("DUST_PERMISSION","The quoted minimum output is too small for a safe session.");
      swaps.push({tokenIn,tokenOut,feeTier:500,maxAmountIn:maxAmountIn.toString(),minAmountOut:minAmountOut.toString()});
    }
    return {accountAddress:account.smartAccountAddress,agentAddress,router:cfg.uniswap.router,swaps,issuedAt:Date.now(),expiresAt,maxGasWei:"3000000000000000",...(allowNativeInput?{nativeWrap:{weth:cfg.uniswap.weth,maxAmountWei:wethAtoms.toString()}}:{})};
  }
  async withAccountLease<T>(accountId:string,run:(assertLease:()=>void)=>Promise<T>):Promise<T>{
    const holder=id(),scope=`account:${accountId}`;
    if(!this.store.takeLease(scope,holder,180_000))throw new ApiError("ACCOUNT_BUSY","Another action is reconciling on this account. Refresh before trying again.",409);
    const assertLease=()=>{if(!this.store.renewLease(scope,holder,180_000))throw new ApiError("LEASE_LOST","Account coordination expired. Reconcile before trying another action.",409);};
    const timer=setInterval(()=>{this.store.renewLease(scope,holder,180_000);},30_000);timer.unref();
    try{return await run(assertLease);}finally{clearInterval(timer);this.store.releaseLease(scope,holder);}
  }
  async checkAgentPolicy(user:User,request:TradeRequest,account:StoredAccount,prepared?:PreparedAction):Promise<StoredPermission>{
    const agent=this.agent(user);
    if(agent.paused)throw new ApiError("AGENT_PAUSED","Resume the agent before requesting autonomous actions.",409);
    const permission=this.store.list<StoredPermission>(user.id,"permission").find(item=>item.accountId===account.id&&item.status==="active"&&item.expiresAt>Date.now()&&item.controlRevision===account.controlRevision);
    if(account.status!=="authorized"||!permission)throw new ApiError("AGENT_NOT_AUTHORIZED","Authorize this agent for the selected account first.",403);
    if(permission.allowedSymbols.length&&!permission.allowedSymbols.includes(request.symbol))throw new ApiError("SYMBOL_NOT_AUTHORIZED","This instrument is outside the agent's approved symbols.",403);
    if(!permission.allowedActions.includes(request.type))throw new ApiError("ACTION_NOT_AUTHORIZED","This action is outside the agent's approved permissions.",403);
    if(account.venue==="ostium"){
      if(request.type==="remove-collateral")throw new ApiError("OWNER_SIGNATURE_REQUIRED","Only the owner can remove collateral through this platform.",403);
      ostiumAcknowledgement(account,permission.agentAddress,permission.authorization);
      await ostiumAuthorization(account,permission.agentAddress);
      if(prepared)validateOstiumExecution(prepared,account,permission);
      return permission;
    }
    if(request.nativeInput&&!permission.policy?.nativeWrap)throw new ApiError("NATIVE_WRAP_NOT_AUTHORIZED","Ask the owner to opt in to bounded native ETH wrapping before the agent spends native trading funds.",403);
    if(request.type!=="cancel"){
      const markets=await callEngine<Market[]>("getMarkets",request.venue);
      const market=markets.find(item=>item.symbol===request.symbol||item.baseAsset===request.symbol.split(/[\/-]/)[0]);
      if(!market||Date.now()-market.observedAt>30_000)throw new ApiError("STALE_MARKET","A fresh reference price is required to check the approved trade cap.",409);
      const tokenIn=request.tokenIn?.toLowerCase();
      const cfg=account.venue==="uniswap"?await callEngine<{uniswap:{usdc:string}}>("engineConfig"):undefined;
      const usdcInput=account.venue==="uniswap"&&(tokenIn?tokenIn===cfg!.uniswap.usdc.toLowerCase():request.side==="buy");
      const notional=decimalProductMicros(request.amount,usdcInput?"1":market.midPrice),cap=decimalProductMicros(permission.maxTradeUsd,"1");
      if(notional>cap)throw new ApiError("TRADE_LIMIT","This trade exceeds the agent's approved per-trade USD cap.",403);
    }
    if(account.venue==="hyperliquid")await this.verifyHyperliquidApproval(account,permission.agentAddress);
    return permission;
  }
  async prepare(user:User,input:unknown,idempotencyKey?:string,initiator:"manual"|"agent"|"automation"="manual",context?:{messageId?:string;instruction?:string;providerRequestId?:string;evaluationId?:string}){
    const request=tradeRequestSchema.parse(input),account=this.account(user,request.accountId);
    let instruction=context?.instruction??(initiator==="manual"?"Manual trade request":"Agent trade request"),providerRequestId=context?.providerRequestId;
    if(context?.messageId){
      const message=this.store.get<StoredMessage>(user.id,"message",context.messageId);
      if(message?.role!=="assistant"||!message.proposedAction||canonicalJson(tradeRequestSchema.parse({...message.proposedAction,mode:request.mode}))!==canonicalJson(request))throw new ApiError("PROPOSAL_MISMATCH","This trade does not match the selected assistant proposal.",409);
      const original=this.store.get<StoredMessage>(user.id,"message",message.id.replace(/:assistant$/u,":user"));
      if(!original||original.role!=="user")throw new ApiError("PROPOSAL_SOURCE_MISSING","The original owner instruction is not available for this proposal.",409);
      instruction=original.content;providerRequestId=message.requestId;initiator="agent";
    }
    rejectMemorySecrets(instruction,{allowPublicHashes:true,code:"CREDENTIAL_INPUT_REJECTED"});
    if(request.venue!==account.venue)throw new ApiError("VENUE_MISMATCH","Action venue does not match the selected account.");
    const actionId=idempotencyKey?createHash("sha256").update(`${user.id}|${idempotencyKey}`).digest("hex"):id();
    const previous=this.store.get<StoredAction>(user.id,"action",actionId);
    if(previous){if(JSON.stringify(previous.request)!==JSON.stringify(request))throw new ApiError("IDEMPOTENCY_CONFLICT","This action ID was already used for a different request.",409);return {action:previous,execution:previous.prepared,preview:previous.prepared.quote};}
    return this.withAccountLease(account.id,async()=>{
      const replay=this.store.get<StoredAction>(user.id,"action",actionId);if(replay){if(canonicalJson(replay.request)!==canonicalJson(request))throw new ApiError("IDEMPOTENCY_CONFLICT","This action ID was already used for a different request.",409);return{action:replay,execution:replay.prepared,preview:replay.prepared.quote};}
      if(account.venue==="ostium"&&this.store.list<StoredAction>(user.id,"action").some(item=>item.accountId===account.id&&item.approvals?.some(step=>["submitting","pending","submitted-unknown"].includes(step.status))))throw new ApiError("ACCOUNT_RECONCILING","Recover the existing owner approval before preparing another native action. No wallet request will be repeated.",409);
      let permission:StoredPermission|undefined;
      if(request.mode==="agent"){
        for(const uncertain of this.store.list<StoredAction>(user.id,"action").filter(item=>item.accountId===account.id&&["submitting","submitted-unknown"].includes(item.status))){
          const reconciled=await this.reconcile(user,uncertain);
          if(["submitting","submitted-unknown"].includes(reconciled.status))throw new ApiError("ACCOUNT_RECONCILING","A previous action still has an unknown venue outcome. Reconcile it before another autonomous trade.",409);
        }
        permission=await this.checkAgentPolicy(user,request,account);
      }
      const prepared=await callEngine<PreparedAction>("prepareAction",request,account);
      prepared.id=actionId;prepared.request=tradeRequestSchema.parse({...prepared.request,accountId:account.id,venue:account.venue,mode:request.mode});prepared.account=account;prepared.controlRevision=account.controlRevision;
      if(account.venue==="ostium")validateOstiumExecution(prepared,account,permission);
      if(request.mode==="agent")permission=await this.checkAgentPolicy(user,prepared.request,account,prepared);
      if(!prepared.expiresAt||prepared.expiresAt<=Date.now())throw new ApiError("QUOTE_EXPIRED","The prepared action expired. Request a new quote.",409);
      const agent=this.agent(user),action=this.store.put("action",{id:actionId,userId:user.id,accountId:account.id,request,status:"awaiting-approval",initiator:initiator!=="manual"?initiator:request.mode==="agent"?"agent":"manual",prepared,controlRevision:account.controlRevision,agentRevision:agent.controlRevision,expiresAt:prepared.expiresAt,providerRequestId,audit:{instruction:instruction.slice(0,10_000),sourceMessageId:context?.messageId,providerRequestId,evaluationId:context?.evaluationId,permission:{decision:permission?"allowed":"owner-signature-required",checkedAt:Date.now(),permissionId:permission?.id,enforcement:permission?.enforcement??"owner",controlRevision:account.controlRevision,agentRevision:agent.controlRevision}},createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredAction);
      return {action,execution:prepared,preview:prepared.quote};
    });
  }
  async submit(user:User,input:{actionId:string;transactionHash?:string;txHash?:string;userOperationHash?:string;orderId?:string;approvalIndex?:number;response?:unknown;result?:unknown}){
    let action=this.store.get<StoredAction>(user.id,"action",input.actionId);
    if(!action)throw new ApiError("ACTION_NOT_FOUND","Prepare this action first.",404);
    const lateOwnerEvidence=Boolean(input.transactionHash||input.txHash||input.userOperationHash||input.orderId||input.response||input.result);
    if(terminalStates.has(action.status)&&input.approvalIndex===undefined&&!(action.status==="cancelled"&&lateOwnerEvidence))return {action};
    const account=this.account(user,action.accountId);
    return this.withAccountLease(account.id,async assertLease=>{
      action=this.store.get<StoredAction>(user.id,"action",input.actionId)!;
      if(terminalStates.has(action.status)&&input.approvalIndex===undefined&&!(action.status==="cancelled"&&lateOwnerEvidence))return{action};
      const transactionHash=input.transactionHash??input.txHash;
      if(transactionHash&&!/^0x[\da-fA-F]{64}$/.test(transactionHash))throw new ApiError("INVALID_TRANSACTION","Invalid transaction hash.");
      if(input.userOperationHash&&!/^0x[\da-fA-F]{64}$/.test(input.userOperationHash))throw new ApiError("INVALID_USER_OPERATION","Invalid user operation hash.");
      const unknownOstium=z.object({venue:z.literal("ostium"),submissionUnknown:z.literal(true),phase:z.enum(["approval","trade"]),approvalIndex:z.number().int().min(0).max(4).optional()}).strict().safeParse(input.result);
      const startingOstiumApproval=z.object({venue:z.literal("ostium"),approvalStarted:z.literal(true),approvalIndex:z.number().int().min(0).max(4)}).strict().safeParse(input.result);
      const startingOstiumTrade=z.object({venue:z.literal("ostium"),tradeStarted:z.literal(true)}).strict().safeParse(input.result);
      const rejectedOstium=z.object({venue:z.literal("ostium"),ownerRejected:z.literal(true),phase:z.enum(["approval","trade"]),approvalIndex:z.number().int().min(0).max(4).optional()}).strict().safeParse(input.result);
      if(account.venue==="ostium"&&(startingOstiumApproval.success||startingOstiumTrade.success)){
        if(transactionHash||input.userOperationHash||input.orderId)throw new ApiError("EVIDENCE_CONFLICT","Record signed evidence separately from the pre-wallet claim.",409);
        const current=this.account(user,account.id);
        if(action.expiresAt<=Date.now())throw new ApiError("QUOTE_EXPIRED","This unsigned quote expired. Do not open another wallet request from it.",409);
        if(action.controlRevision!==current.controlRevision)throw new ApiError("CONTROL_CHANGED","Account control changed after this review. Prepare a fresh owner action.",409);
        if(action.status!=="awaiting-approval"||action.transactionHash)throw new ApiError("ACCOUNT_RECONCILING","This native wallet flow already started. Recover its evidence instead of signing again.",409);
        if(startingOstiumApproval.success)return{action:startOstiumActionApproval(this.store,user,action,startingOstiumApproval.data.approvalIndex)};
        const approvalIndexes=(action.prepared.transactions??[]).map((transaction,index)=>({transaction,index})).filter(({transaction})=>transaction.data.slice(0,10).toLowerCase()==="0x095ea7b3").map(({index})=>index);
        if(approvalIndexes.some(index=>!action!.approvals?.some(step=>step.index===index&&step.status==="confirmed")))throw new ApiError("ALLOWANCE_PENDING","Confirm each exact owner approval before opening the native trade wallet request.",409);
        action=this.store.update<StoredAction>(user.id,"action",action.id,{status:"submitting",error:undefined});return{action};
      }
      if(account.venue==="ostium"&&rejectedOstium.success){
        if(rejectedOstium.data.phase==="approval"){
          if(rejectedOstium.data.approvalIndex===undefined)throw new ApiError("ALLOWANCE_STEP_INVALID","Identify the declined owner approval.",403);
          return{action:rejectOstiumActionApproval(this.store,user,action,rejectedOstium.data.approvalIndex)};
        }
        if(action.status!=="submitting"||action.transactionHash)throw new ApiError("ACCOUNT_RECONCILING","An unknown or signed transaction cannot be dismissed as an unsigned wallet rejection.",409);
        return{action:this.store.update<StoredAction>(user.id,"action",action.id,{status:"rejected",error:"The owner declined the native trade wallet request before signing."})};
      }
      if(account.venue==="ostium"&&unknownOstium.success){
        if(unknownOstium.data.phase==="approval"){
          if(unknownOstium.data.approvalIndex===undefined)throw new ApiError("ALLOWANCE_STEP_INVALID","Identify the owner approval step needing recovery.",403);
          return{action:recordUnknownOstiumApproval(this.store,user,action,unknownOstium.data.approvalIndex)};
        }
        action=this.store.update<StoredAction>(user.id,"action",action.id,{status:"submitted-unknown",error:"The native wallet submission has an unknown result. Recover its hash and reconcile it before any new signature."});
        return{action};
      }
      if(input.approvalIndex!==undefined){
        if(account.venue!=="ostium"||!transactionHash||input.userOperationHash||input.orderId)throw new ApiError("ALLOWANCE_STEP_INVALID","Record a native owner approval separately from the final trading transaction.",403);
        return{action:await recordOstiumActionApproval(this.store,user,action,input.approvalIndex,transactionHash)};
      }
      const ownerEvidence=Boolean(transactionHash||input.userOperationHash||input.orderId||input.response||input.result);
      if(ownerEvidence){
        if(action.transactionHash&&transactionHash&&action.transactionHash.toLowerCase()!==transactionHash.toLowerCase())throw new ApiError("EVIDENCE_CONFLICT","This action already has another transaction hash.",409);
        if(action.userOperationHash&&input.userOperationHash&&action.userOperationHash.toLowerCase()!==input.userOperationHash.toLowerCase())throw new ApiError("EVIDENCE_CONFLICT","This action already has another user operation.",409);
        action=this.store.update<StoredAction>(user.id,"action",action.id,{status:"pending",transactionHash:transactionHash??action.transactionHash,userOperationHash:input.userOperationHash??action.userOperationHash,orderId:input.orderId??action.orderId,evidence:input.response??input.result});
        return {action:await this.reconcile(user,action)};
      }
      if(action.request.mode!=="agent")throw new ApiError("OWNER_SIGNATURE_REQUIRED","Sign and submit this action in your owner wallet first.",409);
      if(["submitting","submitted-unknown","pending","partially-filled"].includes(action.status))return {action:await this.reconcile(user,action)};
      if(action.expiresAt<=Date.now())throw new ApiError("QUOTE_EXPIRED","Prepare a new action because this quote expired.",409);
      const current=this.account(user,account.id),agent=this.agent(user);
      if(current.controlRevision!==action.controlRevision||agent.controlRevision!==action.agentRevision)throw new ApiError("CONTROL_CHANGED","Account control changed after this action was prepared.",409);
      const permission=await this.checkAgentPolicy(user,action.request,current);
      const fresh=await callEngine<PreparedAction>("prepareAction",action.request,current);
      fresh.id=action.id;fresh.request=tradeRequestSchema.parse({...fresh.request,accountId:current.id,venue:current.venue,mode:"agent"});fresh.account=current;fresh.controlRevision=current.controlRevision;
      if(current.venue==="ostium")validateOstiumExecution(fresh,current,permission);
      await this.checkAgentPolicy(user,fresh.request,current,fresh);
      const assertAuthority=(rebuilt?:PreparedAction)=>{
        assertLease();const latest=this.account(user,current.id),latestAgent=this.agent(user),latestPermission=this.store.get<StoredPermission>(user.id,"permission",permission.id);
        if(latest.controlRevision!==action!.controlRevision||latest.status!=="authorized"||latestAgent.paused||latestAgent.controlRevision!==action!.agentRevision||latestPermission?.status!=="active"||latestPermission.expiresAt<=Date.now())throw new ApiError("CONTROL_CHANGED","Authority changed during preparation. No new action was signed.",409);
        if(rebuilt&&latest.venue==="ostium")validateOstiumExecution(rebuilt,latest,latestPermission);
        if(action!.automationId){const strategy=this.store.get<StoredAutomation>(user.id,"automation",action!.automationId);if(!strategy||strategy.status!=="active"||strategy.policySchemaVersion!==1||strategy.policyVersion!==action!.automationPolicyVersion||!action!.automationExecutionOrdinal||action!.automationExecutionOrdinal!==(strategy.executionCount??0)||action!.automationExecutionOrdinal>(strategy.maxExecutions??0)||!action!.evaluationExpiresAt||action!.evaluationExpiresAt<=Date.now())throw new ApiError("STRATEGY_CHANGED","The workflow decision expired, its reserved attempt is invalid or its strategy changed before signing.",409);}
      };
      assertAuthority();
      action=this.store.update<StoredAction>(user.id,"action",action.id,{status:"submitting",prepared:fresh});
      try{
        const key=readSigner(this.store,user.id,`trading:${account.id}`);
        let result:{status?:StoredAction["status"];transactionHash?:string;txHash?:string;userOperationHash?:string;orderId?:string;evidence?:unknown};
        if(current.venue==="uniswap"){
          const wallets=await import("@orcus/wallets/server") as unknown as Record<string,unknown>;
          if(typeof wallets.submitKernelSessionAction!=="function")throw new ApiError("SESSION_UNCONFIGURED","Kernel delegated execution is not configured.",503);
          assertAuthority();
          result=await (wallets.submitKernelSessionAction as (...args:unknown[])=>Promise<typeof result>)(fresh,key,permission.authorization,(evidence:{userOperationHash:string})=>{action=this.store.update<StoredAction>(user.id,"action",action!.id,{status:"pending",userOperationHash:evidence.userOperationHash});},assertAuthority);
        }else {assertAuthority();result=await callEngine("submitAgentAction",fresh,current,key,{assertAuthority,onSubmitted:(evidence:{transactionHash:string;step?:string})=>{if(evidence.step==="approval")throw new ApiError("OWNER_SIGNATURE_REQUIRED","The agent cannot submit owner token allowances.",403);if(!/^0x[\da-fA-F]{64}$/.test(evidence.transactionHash))throw new ApiError("INVALID_TRANSACTION","The adapter did not provide a signed transaction hash.",503);action=this.store.update<StoredAction>(user.id,"action",action!.id,{status:"pending",transactionHash:evidence.transactionHash});}});}
        action=this.store.update<StoredAction>(user.id,"action",action.id,{status:result.status??"pending",transactionHash:result.transactionHash??result.txHash??action.transactionHash,userOperationHash:result.userOperationHash??action.userOperationHash,orderId:result.orderId,evidence:result.evidence});
        return {action:await this.reconcile(user,action)};
      }catch(error){
        const knownPreflight=error instanceof Error&&"phase"in error&&error.phase==="not-submitted"||error instanceof ApiError&&["SESSION_UNCONFIGURED","INVALID_SESSION_APPROVAL","AGENT_NOT_AUTHORIZED","TRADE_LIMIT"].includes(error.code);
        const phase=error instanceof Error&&"phase"in error?error.phase:undefined;
        const evidence=error instanceof Error&&"evidence"in error&&error.evidence&&typeof error.evidence==="object"?error.evidence as{userOperationHash?:unknown;transactionHash?:unknown}:undefined;
        const userOperationHash=typeof evidence?.userOperationHash==="string"&&/^0x[\da-fA-F]{64}$/.test(evidence.userOperationHash)?evidence.userOperationHash:action.userOperationHash;
        const transactionHash=typeof evidence?.transactionHash==="string"&&/^0x[\da-fA-F]{64}$/.test(evidence.transactionHash)?evidence.transactionHash:action.transactionHash;
        this.store.update<StoredAction>(user.id,"action",action.id,{status:knownPreflight||phase==="reverted"?"rejected":"submitted-unknown",userOperationHash,transactionHash,error:errorMessage(error)});
        throw error;
      }
    });
  }
  async reconcile(user:User,action:StoredAction):Promise<StoredAction>{
    try{
      const result=await callEngine<{status?:StoredAction["status"];transactionHash?:string;txHash?:string;orderId?:string;evidence?:unknown;error?:string}>("reconcileAction",{...action,txHash:action.transactionHash},this.account(user,action.accountId));
      const updated=this.store.db.transaction(()=>{
        if(action.request.venue==="ostium"&&(result.status==="confirmed"||result.status==="cancelled")){
          const hash=result.transactionHash??result.txHash??action.transactionHash;
          if(!hash||!/^0x[\da-fA-F]{64}$/.test(hash)||action.transactionHash&&hash.toLowerCase()!==action.transactionHash.toLowerCase())throw new ApiError("OSTIUM_SETTLEMENT_UNVERIFIED","The native settlement has no matching submitted transaction hash.",503);
          const proofId=`ostium-trade-proof:421614:${hash.toLowerCase()}`,previous=this.store.db.prepare("SELECT body FROM records WHERE id=?").get(proofId)as{body:string}|undefined;
          if(previous&&JSON.parse(previous.body).actionId!==action.id)throw new ApiError("TRADE_PROOF_REPLAY","This settled native transaction already belongs to a different action.",409);
          const now=Date.now();this.store.put("ostium-trade-proof",{id:proofId,userId:user.id,actionId:action.id,transactionHash:hash,createdAt:now,updatedAt:now});
        }
        return this.store.update<StoredAction>(user.id,"action",action.id,{status:result.status??action.status,transactionHash:result.transactionHash??result.txHash??action.transactionHash,orderId:result.orderId??action.orderId,evidence:result.evidence??action.evidence,error:result.error});
      }).immediate();
      try{new AgentMemoryStore(this.store,user.id).episode(updated);}catch{}
      return updated;
    }catch(error){return this.store.update<StoredAction>(user.id,"action",action.id,{error:`Reconciliation pending: ${errorMessage(error)}`});}
  }
  async activity(user:User){
    const actions=this.store.list<StoredAction>(user.id,"action",100);
    for(const action of actions.filter(item=>item.request.venue==="ostium"&&item.approvals?.some(step=>step.status==="pending"&&step.transactionHash)).slice(0,10)){
      try{await this.withAccountLease(action.accountId,async()=>{const current=this.store.get<StoredAction>(user.id,"action",action.id)!;for(const step of current.approvals??[])if(step.status==="pending"&&step.transactionHash)await recordOstiumActionApproval(this.store,user,current,step.index,step.transactionHash);});}catch{}
    }
    await Promise.all(actions.filter(action=>["submitting","submitted-unknown","pending","partially-filled"].includes(action.status)).slice(0,10).map(action=>this.reconcile(user,action)));
    return {actions:this.store.list<StoredAction>(user.id,"action",100)};
  }
  async proposal(user:User,message:string,account:StoredAccount|undefined,reference:string,toolProfile:"interactive"|"strategy"="interactive",assertCurrent?:()=>void,requestedModelId?:string){
    assertCurrent?.();
    const modelId=selectedAgentModel(requestedModelId??this.agent(user).modelId),recordId=`proposal:${user.id}:${reference}`;
    const cached=this.store.get<Document&{id:string;userId:string;createdAt:number;updatedAt:number}>(user.id,"proposal",recordId)??this.store.get<Document&{id:string;userId:string;createdAt:number;updatedAt:number}>(user.id,"proposal",reference);
    if(cached){
      if(cached.modelId!==modelId)throw new ApiError("RUN_MODEL_MISMATCH","This saved result belongs to another or unknown model. Start a new request.",409);
      if((cached.toolProfile??"interactive")!==toolProfile)throw new ApiError("TOOL_PROFILE_MISMATCH","This proposal belongs to a different tool profile. Start a new authorized evaluation.",409);
      const agent=this.agent(user),result=cached.result as AgentReply,required=agent.privateVerification==="gateway-reported"?"gateway-reported-private":"independently-attested-private";
      if(agent.privateInferenceRequired&&result.privacy!==required)throw new ApiError("PRIVACY_POLICY_CHANGED","This saved result does not satisfy your current private inference policy. Start a new request.",409);
      return result;
    }
    const runtime=new AgentRun(this.store,user.id,reference,message,memoryId=>this.forgetMemory(user,memoryId),modelId);runtime.start();
    try{
      const agent=this.agent(user),portfolio=await this.portfolio(user);
      const pendingPrompts=new Set(this.store.list<StoredAgentRequest>(user.id,"agent-request",100).filter(request=>request.status==="queued"||request.status==="running").map(request=>request.userMessageId));
      pendingPrompts.add(`${reference}:user`);
      const history=this.store.list<StoredMessage>(user.id,"message",20).filter(item=>!pendingPrompts.has(item.id)).slice(0,9).reverse();
      const context=runtime.context();
      const result=await callEngine<AgentReply>("planWith0G",message,{...context,modelId,modelBudget:{...context.modelBudget,beforeCall:async(input:{callId:string;maxTokens:number})=>{assertCurrent?.();await context.modelBudget.beforeCall(input);}},toolProfile,evaluationId:reference,account,accounts:this.accounts(user),permissions:this.plannerPermissions(user),portfolio,memory:{preferences:agent.preferences,notes:runtime.memory.context(message)},history:history.slice(-8).map(item=>({role:item.role,content:item.content.slice(0,2000)})),requirePrivate:agent.privateInferenceRequired,privateVerification:agent.privateVerification??"independent-gateway"});
      if(result.modelId!==undefined&&result.modelId!==modelId)throw new ApiError("MODEL_RESPONSE_MISMATCH","The model response did not match this run's selected model. No proposal was accepted.",502);
      result.modelId=modelId;
      if(typeof result.message!=="string"||!result.message.trim())throw new ApiError("INVALID_AI_RESULT","The model did not return a valid response. No action was taken.",502);
      if(result.proposal){
        const selected=account??(this.accounts(user).length===1?this.accounts(user)[0]:undefined);
        if(!selected){delete result.proposal;result.requiresClarification=true;result.message="Select which trading account this instruction applies to. No action was taken.";}
        else if(result.proposal.accountId!==selected.id||result.proposal.venue!==selected.venue){delete result.proposal;result.requiresClarification=true;result.message="The proposal targets a different trading account. Select the intended account or clarify your instruction. No action was taken.";}
        else result.proposal=tradeRequestSchema.parse({...result.proposal,mode:"agent"});
      }
      if(result.automationProposal){
        const parsed=automationSchema.safeParse(result.automationProposal),selected=account??(this.accounts(user).length===1?this.accounts(user)[0]:undefined);
        if(!parsed.success||!selected||parsed.data.accountId!==selected.id||parsed.data.request&&(parsed.data.request.accountId!==selected.id||parsed.data.request.venue!==selected.venue)){
          delete result.automationProposal;result.requiresClarification=true;result.message="Clarify the target account and valid strategy settings before creating an automation. No job was created.";
        }else result.automationProposal=parsed.data;
      }
      this.store.put("proposal",{id:recordId,reference,userId:user.id,toolProfile,modelId,result,createdAt:Date.now(),updatedAt:Date.now()});
      runtime.complete(result);
      return result;
    }catch(error){
      runtime.fail(error);
      throw error;
    }finally{runtime.close();}
  }
  runStatus(user:User,requestId:string){
    const reference=createHash("sha256").update(`${user.id}|chat|${requestId}`).digest("hex"),run=readAgentRunStatus(this.store,user.id,requestId)??readAgentRunStatus(this.store,user.id,reference);
    if(!run)throw new ApiError("RUN_NOT_FOUND","This agent run has not started yet.",404);
    const{id,modelId,status,stage,tool,modelCalls,toolCalls,startedAt,updatedAt,completedAt,errorCode}=run;
    return{id:run.runId??id,modelId,status,stage,tool,modelCalls,toolCalls,startedAt,updatedAt,completedAt,errorCode};
  }
  memories(user:User,query?:string){const memory=new AgentMemoryStore(this.store,user.id);return{notes:query?memory.search(query,25):memory.list(50),checkpointAvailable:Boolean(memory.loadCheckpoint(memory.threadId)),warning:"Memory cannot change wallet permissions. Forgetting current notes does not delete existing encrypted 0G backups."};}
  remember(user:User,input:unknown){return new AgentMemoryStore(this.store,user.id).remember(input);}
  forgetMemory(user:User,memoryId:string){
    const memory=new AgentMemoryStore(this.store,user.id),note=memory.get(memoryId);
    if(note?.source==="profile")this.control(user,{command:"update",preferences:""});
    return memory.forget(memoryId)||Boolean(note?.source==="profile");
  }
  agentRequests(user:User){return{requests:listAgentRequests(this.store,user.id)};}
  agentRequest(user:User,requestId:string){return{request:readAgentRequest(this.store,user.id,requestId)};}
  enqueueChat(user:User,input:unknown){
    const data=agentRequestSchema.parse(input);
    rejectMemorySecrets(data.message,{allowPublicHashes:true,code:"CREDENTIAL_INPUT_REJECTED"});
    return this.store.db.transaction(()=>{
      const existing=storedAgentRequest(this.store,user.id,data.requestId),modelId=selectedAgentModel(data.modelId??existing?.modelId??this.agent(user).modelId),fingerprint=chatRequestFingerprint({...data,modelId});
      if(existing){if(existing.requestFingerprint!==fingerprint)throw new ApiError("IDEMPOTENCY_CONFLICT","This request ID was already used for another instruction, account or execution mode.",409);return{request:agentRequestView(this.store,existing)};}
      const agent=this.agent(user);if(data.accountId)this.account(user,data.accountId);
      if(data.autonomous&&(agent.paused||agent.mode!=="autonomous"))throw new ApiError("AGENT_NOT_AUTHORIZED","Enable autonomous mode explicitly before requesting background execution.",403);
      const ownerPending=this.store.db.prepare("SELECT COUNT(*) AS count FROM records WHERE user_id=? AND kind='agent-request' AND json_extract(body,'$.status') IN ('queued','running')").get(user.id)as{count:number};
      const globalPending=this.store.db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='agent-request' AND json_extract(body,'$.status') IN ('queued','running')").get()as{count:number};
      if(ownerPending.count>=5||globalPending.count>=100)throw new ApiError("AGENT_QUEUE_FULL","The agent queue is full. Wait for existing requests to finish instead of submitting duplicates.",429);
      const reference=chatRequestReference(user.id,data.requestId),userMessageId=`${reference}:user`,prior=this.store.get<StoredMessage>(user.id,"message",userMessageId),answer=this.store.get<StoredMessage>(user.id,"message",`${reference}:assistant`);
      if(prior&&prior.requestFingerprint!==fingerprint)throw new ApiError("IDEMPOTENCY_CONFLICT","This request ID already belongs to another or legacy chat instruction. Review its saved result instead of reusing the ID.",409);
      const now=Date.now(),status=answer?"completed":prior?"interrupted":"queued";
      if(!prior)this.store.put("message",{id:userMessageId,userId:user.id,role:"user",content:data.message,modelId,requestFingerprint:fingerprint,accountId:data.accountId,createdAt:now,updatedAt:now}satisfies StoredMessage);
      const request:StoredAgentRequest={id:agentRequestRecordId(user.id,data.requestId),userId:user.id,...data,modelId,runId:reference,userMessageId,status,requestFingerprint:fingerprint,agentRevision:agent.controlRevision,mode:agent.mode,privateInferenceRequired:agent.privateInferenceRequired,privateVerification:agent.privateVerification??"independent-gateway",accountBindings:this.requestAccountBindings(user),permissionBindings:this.requestPermissionBindings(user),expiresAt:now+15*60_000,createdAt:now,updatedAt:now,...(status!=="queued"?{completedAt:now}:{}),...(status==="interrupted"?{errorCode:"AGENT_REQUEST_INTERRUPTED",error:"This instruction was already attempted. Review its saved result and billing; no inference or execution was repeated."}:{})};
      this.store.put("agent-request",request);
      return{request:agentRequestView(this.store,request)};
    }).immediate();
  }
  private requestAccountBindings(user:User){return this.accounts(user).map(account=>({id:account.id,controlRevision:account.controlRevision})).sort((a,b)=>a.id.localeCompare(b.id));}
  private requestPermissionBindings(user:User){return this.store.list<StoredPermission>(user.id,"permission").filter(permission=>permission.status==="active"&&permission.expiresAt>Date.now()).map(permission=>({id:permission.id,controlRevision:permission.controlRevision,expiresAt:permission.expiresAt})).sort((a,b)=>a.id.localeCompare(b.id));}
  private assertAgentRequestBinding(user:User,request:StoredAgentRequest){
    const agent=this.agent(user);
    if(agent.controlRevision!==request.agentRevision||agent.mode!==request.mode||agent.privateInferenceRequired!==request.privateInferenceRequired||(agent.privateVerification??"independent-gateway")!==request.privateVerification||JSON.stringify(this.requestAccountBindings(user))!==JSON.stringify(request.accountBindings)||JSON.stringify(this.requestPermissionBindings(user))!==JSON.stringify(request.permissionBindings))throw new ApiError("AGENT_REQUEST_CHANGED","Queued request authority changed.",409);
    if(request.accountId)this.account(user,request.accountId);
  }
  async tickAgentRequests(assertTick:()=>void){
    assertTick();
    const results:Document[]=[],recovered=recoverInterruptedAgentRequests(this.store);
    if(recovered)results.push({kind:"agent-request",status:"interrupted",count:recovered});
    for(const candidate of queuedAgentRequests(this.store)){
      assertTick();
      const thread=this.store.db.prepare("SELECT expires_at FROM leases WHERE scope=?").get(`agent-thread:${candidate.userId}`)as{expires_at:number}|undefined;
      if(thread&&thread.expires_at>Date.now())continue;
      const holder=id(),scope=agentRequestLease(candidate.id),leaseMs=180_000;
      const claimed=this.store.db.transaction(()=>{
        const current=this.store.get<StoredAgentRequest>(candidate.userId,"agent-request",candidate.id);
        if(!current||current.status!=="queued"||!this.store.takeLease(scope,holder,leaseMs))return;
        const now=Date.now();return this.store.update<StoredAgentRequest>(candidate.userId,"agent-request",candidate.id,{status:"running",claimedBy:holder,startedAt:now,heartbeatAt:now,error:undefined,errorCode:undefined});
      }).immediate();
      if(!claimed)continue;
      let leaseLost=false;
      const assertCurrent=()=>{
        assertTick();const current=this.store.get<StoredAgentRequest>(claimed.userId,"agent-request",claimed.id);
        if(leaseLost||!current||current.status!=="running"||current.claimedBy!==holder||!this.store.renewLease(scope,holder,leaseMs))throw new ApiError("AGENT_LEASE_LOST","The queued request no longer holds execution authority.",409);
        const user=this.storedUser(claimed.userId);if(!user)throw new ApiError("AGENT_REQUEST_NOT_FOUND","The queued request owner is unavailable.",404);
        this.assertAgentRequestBinding(user,claimed);
      };
      const timer=setInterval(()=>{
        if(!this.store.renewLease(scope,holder,leaseMs)){leaseLost=true;return;}
        const current=this.store.get<StoredAgentRequest>(claimed.userId,"agent-request",claimed.id);
        if(current?.status==="running"&&current.claimedBy===holder)this.store.update<StoredAgentRequest>(claimed.userId,"agent-request",claimed.id,{heartbeatAt:Date.now()});
      },30_000);timer.unref();
      try{
        if(claimed.expiresAt<=Date.now())throw new ApiError("AGENT_REQUEST_EXPIRED","The queued instruction expired.",409);
        assertCurrent();const user=this.storedUser(claimed.userId)!;
        await this.chat(user,{message:claimed.message,accountId:claimed.accountId,autonomous:claimed.autonomous,modelId:claimed.modelId,requestId:claimed.requestId},{requestId:claimed.requestId,assertCurrent});
        assertCurrent();this.store.update<StoredAgentRequest>(user.id,"agent-request",claimed.id,{status:"completed",completedAt:Date.now()});
        results.push({kind:"agent-request",requestId:claimed.requestId,status:"completed"});
      }catch(error){
        const latest=this.store.get<StoredAgentRequest>(claimed.userId,"agent-request",claimed.id);
        if(latest?.status==="running"&&latest.claimedBy===holder){
          const safe=safeAgentRequestError(error),expense=this.store.db.prepare("SELECT id,status FROM expenses WHERE user_id=? AND (reference=? OR reference LIKE ?) ORDER BY status='unknown' DESC,status='reserved' DESC LIMIT 1").get(claimed.userId,claimed.runId,`${claimed.runId}:model:%`)as{id:string;status:string}|undefined;
          if(safe.errorCode==="AGENT_BUSY"&&!expense)this.store.update<StoredAgentRequest>(claimed.userId,"agent-request",claimed.id,{status:"queued",startedAt:undefined,heartbeatAt:undefined,claimedBy:undefined});
          else{
            const answer=this.store.get<StoredMessage>(claimed.userId,"message",`${claimed.runId}:assistant`),action=answer?.actionId?this.store.get<StoredAction>(claimed.userId,"action",answer.actionId):undefined;
            const interrupted=expense?.status==="unknown"||expense?.status==="reserved"&&(readAgentRunStatus(this.store,claimed.userId,claimed.runId)?.modelCalls??0)>0||action&&["submitting","submitted-unknown","pending","partially-filled"].includes(action.status)||["AGENT_REQUEST_CHANGED","AGENT_LEASE_LOST","WORKER_LEASE_LOST","INFERENCE_OUTCOME_UNKNOWN","EVALUATION_PENDING","ACTION_RECONCILIATION_REQUIRED"].includes(safe.errorCode),status=interrupted?"interrupted":"failed";
            this.store.update<StoredAgentRequest>(claimed.userId,"agent-request",claimed.id,{status,completedAt:Date.now(),...safe});
            results.push({kind:"agent-request",requestId:claimed.requestId,status});
          }
        }
      }finally{clearInterval(timer);this.store.releaseLease(scope,holder);}
      break;
    }
    return results;
  }
  async chat(user:User,input:{modelId?:string;message:string;accountId?:string;autonomous?:boolean;requestId?:string},background?:{requestId:string;assertCurrent:()=>void}){
    rejectMemorySecrets(input.message,{allowPublicHashes:true,code:"CREDENTIAL_INPUT_REJECTED"});
    if(input.requestId&&storedAgentRequest(this.store,user.id,input.requestId)&&background?.requestId!==input.requestId)throw new ApiError("AGENT_REQUEST_EXISTS","This instruction is already persisted. Read its existing request instead of resubmitting it.",409);
    background?.assertCurrent();
    const reference=input.requestId?createHash("sha256").update(`${user.id}|chat|${input.requestId}`).digest("hex"):id();
    const storedInput=this.store.get<StoredMessage>(user.id,"message",`${reference}:user`),modelId=selectedAgentModel(input.modelId??storedInput?.modelId??this.agent(user).modelId);
    const requestFingerprint=chatRequestFingerprint({...input,modelId});
    const priorUserMessage=this.store.get<StoredMessage>(user.id,"message",`${reference}:user`);
    if(priorUserMessage&&(priorUserMessage.requestFingerprint?priorUserMessage.requestFingerprint!==requestFingerprint:priorUserMessage.content!==input.message))throw new ApiError("IDEMPOTENCY_CONFLICT","This request ID was already used for another chat instruction.",409);
    const priorAssistant=this.store.get<StoredMessage>(user.id,"message",`${reference}:assistant`);
    if(priorAssistant?.actionId){
      const action=this.store.get<StoredAction>(user.id,"action",priorAssistant.actionId);
      if(!action)throw new ApiError("ACTION_RECONCILIATION_REQUIRED","This request was already linked to an execution. Reconcile it before retrying.",409);
      return{message:priorAssistant,proposal:priorAssistant.proposedAction,automationProposal:priorAssistant.automationProposal,runId:reference,requestId:priorAssistant.requestId,action};
    }
    const agent=this.agent(user),account=input.accountId?this.account(user,input.accountId):undefined;
    if(!priorUserMessage)this.store.put("message",{id:`${reference}:user`,userId:user.id,role:"user",content:input.message,modelId,requestFingerprint,accountId:input.accountId,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredMessage);
    const result=await this.proposal(user,input.message,account,reference,"interactive",background?.assertCurrent,modelId);
    let message:StoredMessage=this.store.put("message",{id:`${reference}:assistant`,userId:user.id,role:"assistant",modelId,automationId:priorAssistant?.automationId,content:result.message,requestId:result.requestId,proposedAction:result.proposal,automationProposal:result.automationProposal,privacy:result.privacy,privacyEvidence:result.privacyEvidence,toolSteps:safeAgentToolSteps(result.toolTrace),createdAt:priorAssistant?.createdAt??Date.now(),updatedAt:Date.now()} satisfies StoredMessage);
    background?.assertCurrent();
    let action:StoredAction|undefined;
    if(result.proposal&&input.autonomous&&agent.mode==="autonomous"&&!agent.paused){
      const prepared=await this.prepare(user,result.proposal,`chat:${reference}`,"agent",{instruction:input.message,providerRequestId:result.requestId,messageId:message.id});
      message=this.store.update<StoredMessage>(user.id,"message",message.id,{actionId:prepared.action.id});
      background?.assertCurrent();
      action=(await this.submit(user,{actionId:prepared.action.id})).action;
    }
    return {message,proposal:result.proposal,automationProposal:result.automationProposal,runId:reference,requestId:result.requestId,requestIds:result.requestIds,modelCalls:result.modelCalls,requiresClarification:result.requiresClarification,action};
  }
  automations(user:User){
    for(const automation of this.store.list<StoredAutomation>(user.id,"automation"))this.reviewLegacyAutomation(automation);
    return {automations:this.store.list<StoredAutomation>(user.id,"automation")};
  }
  private reviewLegacyAutomation(automation:StoredAutomation){
    if(automation.policySchemaVersion===1)return automation;
    const error="Review the trade, trigger and finite execution limit before activating this older automation.";
    if(automation.status==="paused"&&automation.error===error)return automation;
    return this.store.update<StoredAutomation>(automation.userId,"automation",automation.id,{status:"paused",error});
  }
  private validateAutomationAccount(user:User,data:AutomationInput){
    const account=this.account(user,data.accountId),agent=this.agent(user);
    assertOstiumAutomation(account,data.request,data.condition);
    if(account.venue!=="ostium"&&data.condition&&!/^\d+(?:\.\d{1,8})?$/.test(data.condition.price))throw new ApiError("INVALID_PRICE_PRECISION","This price source supports at most eight decimal places.");
    if(agent.paused)throw new ApiError("AGENT_PAUSED","Resume the agent before enabling an automation.",409);
    const permission=this.store.list<StoredPermission>(user.id,"permission").find(item=>item.accountId===account.id&&item.status==="active"&&item.expiresAt>Date.now()&&item.controlRevision===account.controlRevision);
    if(data.kind==="trade"&&!permission)throw new ApiError("AGENT_NOT_AUTHORIZED","Authorize agent access before enabling an unattended trading strategy.",403);
    const maximumExpiry=data.kind==="alert"?Date.now()+30*86_400_000:permission!.expiresAt;
    const expiresAt=data.expiresAt??maximumExpiry;
    if(expiresAt<=Date.now()||expiresAt>maximumExpiry)throw new ApiError("INVALID_EXPIRY",data.kind==="alert"?"Alerts must expire within 30 days.":"Strategy expiry must be within its agent permission lifetime.");
    if(data.request&&(data.request.accountId!==account.id||data.request.venue!==account.venue))throw new ApiError("ACCOUNT_MISMATCH","Strategy action belongs to a different account.");
    if(data.request&&data.condition&&!automationMarketMatches(account.venue,data.request.symbol,data.condition.symbol))throw new ApiError("CONDITION_MARKET_MISMATCH","The condition must name the same market as the reviewed trade.");
    return{account,expiresAt};
  }
  notifications(user:User){const notifications=this.store.list<Document&{readAt?:number}>(user.id,"notification",100);return{notifications,unreadCount:notifications.filter(item=>!item.readAt).length};}
  readNotification(user:User,notificationId:string){return this.store.update<Document&{id:string;userId:string;createdAt:number;updatedAt:number}>(user.id,"notification",notificationId,{readAt:Date.now()});}
  createAutomation(user:User,input:unknown,idempotencyKey?:string){
    const data=automationSchema.parse(input);
    if(data.instruction)rejectMemorySecrets(data.instruction,{allowPublicHashes:true,code:"CREDENTIAL_INPUT_REJECTED"});
    const fingerprint=createHash("sha256").update(canonicalJson(data)).digest("hex"),automationId=idempotencyKey?createHash("sha256").update(`${user.id}|automation|${idempotencyKey}`).digest("hex"):id();
    return this.store.db.transaction(()=>{
    const existing=this.store.get<StoredAutomation>(user.id,"automation",automationId);
    if(existing){if(existing.inputFingerprint!==fingerprint)throw new ApiError("IDEMPOTENCY_CONFLICT","This acceptance ID was already used for a different automation.",409);return existing;}
    const sourceMessageId=idempotencyKey?.startsWith("chat-automation:")?idempotencyKey.slice("chat-automation:".length):undefined;
    const source=sourceMessageId?this.store.get<StoredMessage>(user.id,"message",sourceMessageId):undefined;
    if(sourceMessageId&&(!source||source.role!=="assistant"||!source.automationProposal||canonicalJson(automationSchema.parse(source.automationProposal))!==canonicalJson(data)))throw new ApiError("PROPOSAL_MISMATCH","Review the original assistant automation proposal before activating it.",409);
    const{account,expiresAt}=this.validateAutomationAccount(user,data);
    const created=this.store.put("automation",{id:automationId,userId:user.id,accountId:account.id,kind:data.kind,name:data.name,instruction:data.instruction??(data.kind==="alert"?"Monitor the reviewed price condition":"Execute only the reviewed trade and trigger"),request:data.request?{...data.request,mode:"agent"}:undefined,condition:data.condition,executionMode:data.executionMode,maxExecutions:data.maxExecutions,executionCount:0,policySchemaVersion:1,intervalSeconds:data.intervalSeconds,status:"active",nextRunAt:Date.now(),policyVersion:1,controlRevision:account.controlRevision,inputFingerprint:fingerprint,sourceMessageId,providerRequestId:source?.requestId,expiresAt,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredAutomation);
    if(source)this.store.update<StoredMessage>(user.id,"message",source.id,{automationId:created.id});
    return created;
    }).immediate();
  }
  updateAutomation(user:User,automationId:string,value:AutomationUpdate){
    const input=automationUpdateSchema.parse(value);
    if(input.instruction)rejectMemorySecrets(input.instruction,{allowPublicHashes:true,code:"CREDENTIAL_INPUT_REJECTED"});
    return this.store.db.transaction(()=>{
      const automation=this.store.get<StoredAutomation>(user.id,"automation",automationId);if(!automation)throw new ApiError("NOT_FOUND","Automation not found.",404);
      const changesPolicy=["request","condition","executionMode","maxExecutions","intervalSeconds","expiresAt"].some(key=>key in input);
      if(input.instruction&&!changesPolicy)throw new ApiError("STRUCTURED_REVIEW_REQUIRED","Instructions are descriptive. Review the trade, condition or schedule to change execution.",409);
      if(!changesPolicy&&input.status==="paused")return this.store.update<StoredAutomation>(user.id,"automation",automationId,{status:"paused",policyVersion:automation.policyVersion+1});
      if(automation.runningEvaluationId)throw new ApiError("AUTOMATION_BUSY","Wait for the current evaluation to finish before changing or resuming this automation.",409);
      if(automation.policySchemaVersion!==1&&(!input.executionMode||input.maxExecutions===undefined))throw new ApiError("STRUCTURED_REVIEW_REQUIRED","Review an explicit execution mode and limit before resuming this older automation.",409);
      if(automation.status==="completed"||(automation.executionCount??0)>=(automation.maxExecutions??Infinity))throw new ApiError("AUTOMATION_EXHAUSTED","This automation used its execution limit. Create a newly reviewed automation instead.",409);
      const data=automationSchema.parse({kind:automation.kind??"trade",accountId:automation.accountId,name:input.name??automation.name,instruction:input.instruction??automation.instruction,request:input.request??automation.request,condition:input.condition===null?undefined:input.condition??automation.condition,executionMode:input.executionMode??automation.executionMode,maxExecutions:input.maxExecutions??automation.maxExecutions,intervalSeconds:input.intervalSeconds??automation.intervalSeconds,expiresAt:input.expiresAt??automation.expiresAt});
      if((automation.executionCount??0)>=data.maxExecutions)throw new ApiError("AUTOMATION_EXHAUSTED","The execution limit must exceed the attempts already consumed.",409);
      const{account,expiresAt}=this.validateAutomationAccount(user,data);
      return this.store.update<StoredAutomation>(user.id,"automation",automationId,{...data,request:data.request?{...data.request,mode:"agent"}:undefined,instruction:data.instruction??automation.instruction,status:input.status??automation.status,policySchemaVersion:1,executionCount:automation.executionCount??0,policyVersion:automation.policyVersion+1,controlRevision:account.controlRevision,expiresAt,nextRunAt:Date.now(),conditionActive:changesPolicy?undefined:automation.conditionActive,lastOutcome:changesPolicy?undefined:automation.lastOutcome,lastEvaluation:changesPolicy?undefined:automation.lastEvaluation,sourceMessageId:changesPolicy?undefined:automation.sourceMessageId,providerRequestId:changesPolicy?undefined:automation.providerRequestId,error:undefined});
    }).immediate();
  }
  async reconcileStorage(user:User,expenseId:string){
    const expense=listStorageExpenses(this.store,user.id).find(item=>item.id===expenseId);
    if(!expense)throw new ApiError("NOT_FOUND","This storage expense does not exist for your account.",404);
    if(expense.status!=="submitted-unknown")return expense;
    return recordStorageExpense(this.store,user.id,await callEngine("reconcileStorageExpense",expense));
  }
  private memoryPayer(user:User,limits:{maxGas0G?:string;maxStorageFee0G?:string}={}){
    return selectStoragePayer(this.store,user,{limits,agent:()=>({payerAddress:this.agent(user).operatingAddress,privateKey:readSigner(this.store,user.id,"operating")})});
  }
  async memory(user:User,action:"backup"|"restore",limits:{maxGas0G?:string;maxStorageFee0G?:string;expectedFlowAddress?:string}={}){
    const key=memoryKey(this.store,user.id);
    try{
      if(action==="backup"){
        const longTerm=new AgentMemoryStore(this.store,user.id).snapshot();
        const content={version:2,agent:{preferences:this.agent(user).preferences},messages:this.store.list<StoredMessage>(user.id,"message",16).map(({role,content,createdAt})=>({role,content:content.slice(0,4000),createdAt})),longTerm,capturedAt:Date.now()};
        while(Buffer.byteLength(JSON.stringify(content))>750_000&&content.longTerm.notes.length)content.longTerm.notes.pop();
        if(Buffer.byteLength(JSON.stringify(content))>750_000)throw new ApiError("MEMORY_TOO_LARGE","Compact the active checkpoint before backing up this memory.",413);
        const payer=this.memoryPayer(user,limits);
        const result=await this.withAccountLease(payer.scope,async assertLease=>{
          let signedHash:string|undefined;
          const assertAuthority=()=>{assertLease();assertStoragePayerAllowance(this.store,payer,signedHash);};
          if(listStorageExpenses(this.store,user.id).some(expense=>expense.status==="submitted-unknown"))throw new ApiError("STORAGE_OUTCOME_UNKNOWN","Reconcile the previous storage expense before paying for another backup.",409);
          assertAuthority();
          return callEngine<Document>("uploadMemory",content,key,payer.privateKey,{...payer.limits,expectedFlowAddress:limits.expectedFlowAddress,assertAuthority,onSubmissionIntent:(expense:unknown)=>{assertStoragePayerAllowance(this.store,payer);const record=recordStorageExpense(this.store,user.id,expense);signedHash=record.transactionHash;},onExpense:(expense:unknown)=>{recordStorageExpense(this.store,user.id,expense);}});
        });
        const rootHash=result.rootHash??result.root;
        if(result.status!=="confirmed"||typeof rootHash!=="string"||!/^0x[\da-fA-F]{64}$/.test(rootHash))throw new ApiError("STORAGE_UNCONFIRMED","Storage did not confirm an uploaded root. No backup was marked successful.",502);
        return this.store.put("memory",{id:id(),userId:user.id,rootHash,status:"confirmed",evidence:result,noteCount:longTerm.notes.length,messageCount:content.messages.length,createdAt:Date.now(),updatedAt:Date.now()});
      }
      const backup=this.store.list<Document&{rootHash:string}>(user.id,"memory")[0];if(!backup)throw new ApiError("MEMORY_NOT_FOUND","Create a confirmed encrypted backup first.",404);
      const raw=await callEngine<unknown>("downloadMemory",backup.rootHash,key);
      const content=z.object({version:z.union([z.literal(1),z.literal(2)]),agent:z.object({preferences:z.string().max(4000).optional()}).optional(),messages:z.array(z.object({role:z.enum(["user","assistant"]),content:z.string().max(20_000),createdAt:z.number().int().positive()})).max(100),longTerm:z.object({notes:z.array(z.unknown()).max(200),checkpoint:z.unknown().optional()}).optional(),capturedAt:z.number().optional()}).strict().parse(raw);
      const memory=new AgentMemoryStore(this.store,user.id),holder=id(),scope=`agent-thread:${user.id}`;
      if(!this.store.takeLease(scope,holder,30_000))throw new ApiError("AGENT_BUSY","Wait for the current agent run before restoring its memory.",409);
      try{return this.store.db.transaction(()=>{
        const noteCount=content.longTerm?memory.restoreNotes(content.longTerm.notes):0;
        if(content.longTerm?.checkpoint!==undefined&&content.longTerm.checkpoint!==null)memory.saveCheckpoint(memory.threadId,content.longTerm.checkpoint);
        if(typeof content.agent?.preferences==="string"&&!memory.wasForgotten(content.agent.preferences))this.control(user,{command:"update",preferences:content.agent.preferences});
        for(const item of content.messages){const messageId=createHash("sha256").update(`${user.id}|${item.role}|${item.content}|${item.createdAt}`).digest("hex");this.store.put("message",{id:messageId,userId:user.id,role:item.role,content:item.content,createdAt:item.createdAt,updatedAt:Date.now()});}
        return {restored:true,messageCount:content.messages.length,noteCount,rootHash:backup.rootHash};
      })();}finally{this.store.releaseLease(scope,holder);}
    }finally{key.fill(0);}
  }
  async tick(){
    const tickHolder=id(),tickScope="worker:tick",results:Document[]=[],leaseMs=360_000;
    if(!this.store.takeLease(tickScope,tickHolder,leaseMs))return{processed:0,results,busy:true,observedAt:Date.now()};
    const assertTick=()=>{if(!this.store.renewLease(tickScope,tickHolder,leaseMs))throw new ApiError("WORKER_LEASE_LOST","Another worker now owns reconciliation. This tick cannot authorize new actions.",409);};
    const tickTimer=setInterval(()=>{this.store.renewLease(tickScope,tickHolder,leaseMs);},30_000);tickTimer.unref();
    try{
    results.push(...await this.tickComputeFunding(assertTick));
    for(const interrupted of this.store.interruptedAutomations<StoredAutomation>(10)){
      assertTick();
      const reason="The previous worker stopped during evaluation. Review the job and reconcile any submitted action before resuming; no trade was retried.";
      this.store.update<StoredAutomation>(interrupted.userId,"automation",interrupted.id,{status:interrupted.status==="active"?"failed":interrupted.status,runningEvaluationId:undefined,runningStartedAt:undefined,error:reason});
      this.store.put("evaluation-run",{id:this.evaluationRunRecordId(interrupted.userId,interrupted.runningEvaluationId!),evaluationId:interrupted.runningEvaluationId!,userId:interrupted.userId,automationId:interrupted.id,accountId:interrupted.accountId,status:"interrupted",reason,createdAt:interrupted.runningStartedAt??Date.now(),updatedAt:Date.now()});
      results.push({automationId:interrupted.id,status:"interrupted",evaluationId:interrupted.runningEvaluationId});
    }
    let reconciled=0;
    for(const pending of this.store.pendingActions<StoredAction>(5)){
      assertTick();
      const user=this.storedUser(pending.userId);if(!user)continue;
      try{await this.withAccountLease(pending.accountId,async()=>{const latest=this.store.get<StoredAction>(user.id,"action",pending.id);if(latest&&!terminalStates.has(latest.status)){await this.reconcile(user,latest);reconciled++;}});}
      catch(error){if(!(error instanceof ApiError&&error.code==="ACCOUNT_BUSY"))results.push({actionId:pending.id,status:"reconciliation-pending",error:errorMessage(error)});}
    }
    for(const automation of this.store.dueAutomations<StoredAutomation>(3)){
      assertTick();
      const evaluationId=createHash("sha256").update(`${automation.id}|${automation.nextRunAt}|${automation.policyVersion}`).digest("hex"),holder=id(),scope=`evaluation:${automation.id}`;
      if(!this.store.takeLease(scope,holder,360_000))continue;
      const timer=setInterval(()=>{this.store.renewLease(scope,holder,360_000);},30_000);timer.unref();
      const user=this.storedUser(automation.userId);
      if(!user){clearInterval(timer);this.store.releaseLease(scope,holder);continue;}
      let marked=false,evaluationAccepted=false;
      try{
        const current=this.store.get<StoredAutomation>(user.id,"automation",automation.id)!;
        if(current.status!=="active"||current.nextRunAt>Date.now())continue;
        if(current.policySchemaVersion!==1){this.reviewLegacyAutomation(current);continue;}
        if((current.executionCount??0)>=(current.maxExecutions??0)){this.store.update<StoredAutomation>(user.id,"automation",current.id,{status:"completed"});continue;}
        automationSchema.parse({kind:current.kind??"trade",accountId:current.accountId,name:current.name,instruction:current.instruction,request:current.request,condition:current.condition,executionMode:current.executionMode,maxExecutions:current.maxExecutions,intervalSeconds:current.intervalSeconds,expiresAt:current.expiresAt});
        const agent=this.agent(user);
        if(agent.paused||current.expiresAt<=Date.now()){this.store.update<StoredAutomation>(user.id,"automation",current.id,{status:current.expiresAt<=Date.now()?"expired":"paused"});continue;}
        if(this.store.get(user.id,"evaluation",evaluationId)){this.store.update<StoredAutomation>(user.id,"automation",current.id,{status:"failed",error:"This evaluation was already consumed. Review its existing action before resuming."});continue;}
        const account=this.account(user,current.accountId);
        assertOstiumAutomation(account,current.request,current.condition);
        if(account.controlRevision!==current.controlRevision)throw new ApiError("CONTROL_CHANGED","Account control changed. Review this strategy before resuming.",409);
        const alert=current.kind==="alert";
        if(!alert&&!this.store.list<StoredPermission>(user.id,"permission").some(permission=>permission.accountId===account.id&&permission.status==="active"&&permission.expiresAt>Date.now()&&permission.controlRevision===account.controlRevision))throw new ApiError("AGENT_NOT_AUTHORIZED","Renew agent authorization before running this strategy.",403);
        this.store.db.transaction(()=>{
          this.store.update<StoredAutomation>(user.id,"automation",current.id,{runningEvaluationId:evaluationId,runningStartedAt:Date.now(),nextRunAt:Date.now()+current.intervalSeconds*1000,error:undefined});
          this.store.put("evaluation-run",{id:this.evaluationRunRecordId(user.id,evaluationId),evaluationId,userId:user.id,automationId:current.id,accountId:account.id,status:"running",policyVersion:current.policyVersion,controlRevision:current.controlRevision,createdAt:Date.now(),updatedAt:Date.now()});
        }).immediate();marked=true;
        const assertCurrent=()=>{
          assertTick();
          if(!this.store.renewLease(scope,holder,360_000))throw new ApiError("EVALUATION_LEASE_LOST","Evaluation coordination expired. No new action may use this result.",409);
          const latest=this.store.get<StoredAutomation>(user.id,"automation",current.id),latestAccount=this.account(user,account.id),latestAgent=this.agent(user);
          if(!latest||latest.runningEvaluationId!==evaluationId||latest.policyVersion!==current.policyVersion||latest.status!=="active"||latest.expiresAt<=Date.now()||latest.controlRevision!==current.controlRevision||latestAccount.controlRevision!==account.controlRevision||latestAgent.paused||latestAgent.controlRevision!==agent.controlRevision)throw new ApiError("STRATEGY_CHANGED","Strategy or account authority changed while its workflow was running.",409);
          return latest;
        };
        const planned={proposal:alert?undefined:current.request,requestId:current.providerRequestId};
        assertCurrent();
        const proposal=planned.proposal;
        assertOstiumAutomation(account,proposal,current.condition);
        if(!proposal&&!alert){
          this.store.put("evaluation",{id:evaluationId,userId:user.id,automationId:current.id,accountId:account.id,decision:"no-action",source:"planner",reason:"No executable proposal was returned. CRE was not invoked and no trade was authorized.",requestId:planned.requestId,createdAt:Date.now(),updatedAt:Date.now()});
          results.push({automationId:current.id,evaluationId,decision:"no-action",source:"planner"});
          continue;
        }
        const raw=await callEngine<Document>("evaluateStrategy",{kind:alert?"alert":"trade",evaluationId,automationId:current.id,account,request:proposal,proposal,requestId:planned.requestId,instruction:current.instruction,condition:current.condition,controlRevision:current.controlRevision,policyVersion:current.policyVersion,expiresAt:Math.min(current.expiresAt,Date.now()+120_000)});
        const evaluation=evaluationSchema.parse({...raw,id:raw.id??raw.evaluationId});
        if(evaluation.id!==evaluationId||evaluation.automationId!==current.id||evaluation.accountId!==account.id||evaluation.chainId!==account.chainId||evaluation.controlRevision!==account.controlRevision||evaluation.policyVersion!==current.policyVersion||evaluation.requestId!==planned.requestId||evaluation.expiresAt<=Date.now()||evaluation.observedAt>Date.now()+5000||Date.now()-evaluation.observedAt>120_000)throw new ApiError("INVALID_CRE_RESULT","Workflow result is stale, unbound or not an authenticated local simulation.",502);
        const latest=assertCurrent();
        this.store.put("evaluation",{...evaluation,id:evaluationId,userId:user.id,createdAt:Date.now(),updatedAt:Date.now()});
        evaluationAccepted=true;
        this.store.update<StoredAutomation>(user.id,"automation",current.id,{lastEvaluation:evaluation as unknown as StoredAutomation["lastEvaluation"]});
        const matches=evaluation.decision==="allow",crossing=current.executionMode==="on-crossing";
        const triggered=matches&&(!crossing||latest.conditionActive===false);
        const waitingReason=crossing&&latest.conditionActive===undefined?"Initial observation saved. Waiting for a new false-to-true threshold crossing.":crossing&&matches&&!triggered?"Condition is still met. Waiting for it to clear and cross again.":evaluation.reason;
        this.store.update<StoredAutomation>(user.id,"automation",current.id,{lastOutcome:{status:evaluation.decision==="reject"?"rejected":crossing&&latest.conditionActive===undefined?"armed":"waiting",reason:waitingReason,observedAt:evaluation.observedAt}});
        if(evaluation.decision!=="reject"&&current.condition)this.store.update<StoredAutomation>(user.id,"automation",current.id,{conditionActive:matches});
        if(alert){
          if(triggered&&(crossing||!latest.conditionActive)){
            const notificationId=createHash("sha256").update(`${user.id}|alert|${current.id}|${evaluationId}`).digest("hex");
            this.store.db.transaction(()=>{
              this.store.put("notification",{id:notificationId,userId:user.id,automationId:current.id,evaluationId,kind:"price-alert",symbol:current.condition?.symbol,message:`${current.name}: ${evaluation.reason}`.slice(0,500),observedAt:evaluation.observedAt,createdAt:Date.now(),updatedAt:Date.now()});
              const executionCount=(latest.executionCount??0)+1;
              this.store.update<StoredAutomation>(user.id,"automation",current.id,{executionCount,status:executionCount>=current.maxExecutions!?"completed":"active",lastOutcome:{status:"notified",reason:"The price condition triggered an owner notification. No trade was submitted.",observedAt:evaluation.observedAt}});
            }).immediate();
          }
          results.push({automationId:current.id,evaluationId,decision:matches&&!triggered?"no-action":evaluation.decision,kind:"alert",...(matches&&!triggered?{reason:"Waiting for the next observed threshold crossing."}:{})});
        }else if(triggered){
          if(!proposal)throw new ApiError("MISSING_PROPOSAL","Workflow allowed no executable proposal.",502);
          const prepared=await this.prepare(user,{...proposal,mode:"agent"},`evaluation:${evaluationId}`,"automation",{instruction:current.instruction,providerRequestId:planned.requestId,evaluationId});
          this.store.db.transaction(()=>{
            const live=assertCurrent(),executionCount=(live.executionCount??0)+1;
            if(executionCount>current.maxExecutions!)throw new ApiError("AUTOMATION_EXHAUSTED","This automation has no execution attempts remaining.",409);
            this.store.update<StoredAutomation>(user.id,"automation",current.id,{executionCount});
            this.store.update<StoredAction>(user.id,"action",prepared.action.id,{automationId:current.id,automationPolicyVersion:current.policyVersion,automationExecutionOrdinal:executionCount,evaluationExpiresAt:evaluation.expiresAt});
          }).immediate();
          const submitted=await this.submit(user,{actionId:prepared.action.id});
          const afterSubmit=this.store.get<StoredAutomation>(user.id,"automation",current.id)!;
          this.store.update<StoredAutomation>(user.id,"automation",current.id,{lastOutcome:{status:submitted.action.status==="rejected"?"rejected":"submitted",reason:submitted.action.status==="rejected"?"The venue rejected the submitted action. Review its activity record.":"The reviewed trade was submitted. Its activity record tracks settlement separately.",observedAt:Date.now(),actionId:submitted.action.id}});
          if((afterSubmit.executionCount??0)>=current.maxExecutions!&&afterSubmit.policyVersion===current.policyVersion&&afterSubmit.status==="active")this.store.update<StoredAutomation>(user.id,"automation",current.id,{status:"completed"});
          results.push({automationId:current.id,evaluationId,decision:evaluation.decision,actionId:submitted.action.id,status:submitted.action.status});
        }else results.push({automationId:current.id,evaluationId,decision:matches?"no-action":evaluation.decision,...(matches?{reason:"Waiting for the next observed threshold crossing."}:{})});
      }catch(error){
        const latest=this.store.get<StoredAutomation>(user.id,"automation",automation.id);
        if(!latest||marked&&latest.runningEvaluationId!==evaluationId)continue;
        const retryCount=(latest.retryCount??0)+1,busy=!evaluationAccepted&&error instanceof ApiError&&["AGENT_BUSY","ACCOUNT_BUSY","ACCOUNT_RECONCILING"].includes(error.code)&&retryCount<=5;
        if(busy){this.store.update<StoredAutomation>(user.id,"automation",automation.id,{retryCount,nextRunAt:Date.now()+Math.min(300_000,15_000*2**(retryCount-1)),error:errorMessage(error)});results.push({automationId:automation.id,status:"waiting",error:errorMessage(error)});}
        else{const status=latest.status!=="active"?latest.status:error instanceof ApiError&&error.code==="INSUFFICIENT_BUDGET"?"insufficient-budget":"failed";this.store.update<StoredAutomation>(user.id,"automation",automation.id,{status,retryCount,error:errorMessage(error),lastOutcome:{status:"failed",reason:errorMessage(error),observedAt:Date.now()}});results.push({automationId:automation.id,error:errorMessage(error),status});}
      }
      finally{
        const latest=this.store.get<StoredAutomation>(user.id,"automation",automation.id);
        if(marked&&latest?.runningEvaluationId===evaluationId){this.store.update<StoredAutomation>(user.id,"automation",automation.id,{runningEvaluationId:undefined,runningStartedAt:undefined,...(!latest.error?{retryCount:0}:{})});this.store.update<StoredEvaluationRun>(user.id,"evaluation-run",this.evaluationRunRecordId(user.id,evaluationId),{status:latest.error?"failed":"completed",completedAt:Date.now()});}
        clearInterval(timer);this.store.releaseLease(scope,holder);
      }
    }
    results.push(...await this.tickAgentRequests(assertTick));
    return {processed:results.length,results,reconciled,observedAt:Date.now()};
    }finally{clearInterval(tickTimer);this.store.releaseLease(tickScope,tickHolder);}
  }
  private evaluationRunRecordId(userId:string,evaluationId:string):string{
    const recordId=`evaluation-run:${evaluationId}`;
    const legacy=this.store.get<StoredEvaluationRun>(userId,"evaluation-run",evaluationId);
    if(legacy&&!this.store.get(userId,"evaluation-run",recordId))this.store.db.prepare("UPDATE records SET id=?,body=json_set(body,'$.id',?,'$.evaluationId',?) WHERE id=? AND user_id=? AND kind='evaluation-run'").run(recordId,recordId,evaluationId,evaluationId,userId);
    return recordId;
  }
  private storedUser(userId:string):User|undefined{const row=this.store.db.prepare("SELECT id,address,created_at FROM users WHERE id=?").get(userId)as{id:string;address:string;created_at:number}|undefined;return row?{id:row.id,address:row.address,createdAt:row.created_at}:undefined;}
}

function decimalProductMicros(a:string,b:string):bigint{
  if(!/^\d+(?:\.\d+)?$/.test(a)||!/^\d+(?:\.\d+)?$/.test(b)||a.length>80||b.length>80)throw new ApiError("INVALID_AMOUNT","Invalid exact decimal amount.");
  const [aw,af=""]=a.split("."),[bw,bf=""]=b.split("."),scale=10n**BigInt(af.length+bf.length),product=BigInt(aw+af)*BigInt(bw+bf)*1_000_000n;
  return (product+scale-1n)/scale;
}
function canonicalJson(value:unknown):string{
  if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;
  if(value&&typeof value==="object")return`{${Object.keys(value).filter(key=>(value as Document)[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson((value as Document)[key])}`).join(",")}}`;
  return JSON.stringify(value)??"null";
}
