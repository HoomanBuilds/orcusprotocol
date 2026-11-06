import { createHash } from "node:crypto";
import { formatUnits, getAddress, parseUnits } from "viem";
import type { KernelGrantPolicy } from "@orcus/wallets/kernel";
import { tradeRequestSchema,type PreparedAction,type TradeRequest,type User,type Portfolio,type Market,type HealthStatus } from "@orcus/core";
import { z } from "zod";
import { getBudget,setBudget } from "./budget";
import { assertComputeFundingAuthority,cancelComputeFunding,configureComputeFunding,getComputeFundingPolicy,prepareComputeFunding,recordComputeFundingSubmission,settleComputeFunding } from "./compute-funding";
import type { ComputeFundingResult } from "@orcus/engine/budget";
import { callEngine } from "./engine";
import { ApiError,errorMessage } from "./errors";
import { createSigner,memoryKey,readSigner } from "./keystore";
import { getStore,id,type Store } from "./store";
import type { Document,StoredAccount,StoredAction,StoredAgent,StoredAutomation,StoredEvaluationRun,StoredMessage,StoredPermission } from "./types";
import { AgentMemoryStore,rejectMemorySecrets } from "./memory";
import { AgentRun,type AgentRunStatus } from "./agent-runtime";
import { listStorageExpenses,recordStorageExpense } from "./storage-expenses";

export const accountSchema=z.object({venue:z.enum(["uniswap","hyperliquid"]),address:z.string().optional(),smartAccountAddress:z.string().optional(),chainId:z.number().int().optional(),label:z.string().max(80).optional()}).strict();
export const automationSchema=z.object({kind:z.enum(["trade","alert"]).default("trade"),accountId:z.string(),name:z.string().min(1).max(80),instruction:z.string().min(1).max(2000).optional(),intervalSeconds:z.number().int().min(60).max(86400).default(300),request:tradeRequestSchema.optional(),condition:z.object({symbol:z.string().min(1).max(50),operator:z.enum(["above","below"]),price:z.string().max(80).regex(/^\d+(?:\.\d+)?$/).refine(value=>/[1-9]/.test(value),"Use a positive alert threshold")}).optional(),expiresAt:z.number().int().optional()}).strict().superRefine((value,ctx)=>{if(value.kind==="alert"&&(!value.condition||value.request))ctx.addIssue({code:"custom",message:"Price alerts require a condition and cannot contain a trade request."});if(value.kind==="trade"&&!value.request&&!value.instruction)ctx.addIssue({code:"custom",message:"Trading strategies require an instruction or an explicitly approved recurring request."});});
const terminalStates=new Set(["confirmed","rejected","cancelled"]);
const evaluationSchema=z.object({id:z.string(),automationId:z.string(),accountId:z.string(),chainId:z.number().int(),decision:z.enum(["allow","reject","no-action"]),reason:z.string(),source:z.literal("local-simulation"),observedAt:z.number().int(),expiresAt:z.number().int(),controlRevision:z.number().int(),policyVersion:z.number().int(),requestId:z.string().optional()}).passthrough();
type AgentReply={message:string;proposal?:TradeRequest;automationProposal?:unknown;requestId?:string;requestIds?:string[];modelCalls?:number;usage?:unknown;costUsd?:string;requiresClarification?:boolean;privacy?:StoredMessage["privacy"];privacyEvidence?:unknown};

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
      return{id:permission.id,accountId:permission.accountId,venue:account?.venue,allowedActions:permission.allowedActions,allowedSymbols:permission.allowedSymbols,maxTradeUsd:permission.maxTradeUsd,expiresAt:permission.expiresAt,enforcement:permission.enforcement,controlRevision:permission.controlRevision,...(permission.policy?{onchain:{kind:"kernel-fixed-output-bands",router:permission.policy.router,recipient:permission.policy.accountAddress,swaps:permission.policy.swaps.map(swap=>({tokenIn:swap.tokenIn,tokenOut:swap.tokenOut,feeTier:swap.feeTier,maximumInputAtoms:swap.maxAmountIn,minimumOutputAtoms:swap.minAmountOut})),limitation:"Each permitted input cap has a fixed minimum output floor. A smaller input may be outside the band even below the USD cap. Propose an exact permitted amount when appropriate or ask the owner to regrant; never lower the minimum output or claim arbitrary up-to-cap amounts are executable."}}:{})};
    });
  }
  createAccount(user:User,input:unknown){
    const data=accountSchema.parse(input),address=getAddress(data.smartAccountAddress??data.address??user.address),chainId=data.chainId??(data.venue==="uniswap"?11155111:421614);
    if(chainId!==(data.venue==="uniswap"?11155111:421614))throw new ApiError("UNSUPPORTED_NETWORK","Only configured Sepolia and Hyperliquid testnet accounts are supported.");
    if(data.venue==="hyperliquid"&&address.toLowerCase()!==user.address.toLowerCase())throw new ApiError("OWNER_MISMATCH","Use the connected owner address for Hyperliquid.");
    const existing=this.accounts(user).find(account=>account.venue===data.venue&&account.address.toLowerCase()===address.toLowerCase());if(existing)return existing;
    const accountId=id(),signer=createSigner(this.store,user.id,`trading:${accountId}`);
    return this.store.put("account",{id:accountId,userId:user.id,venue:data.venue,address,ownerAddress:user.address,chainId,label:data.label??(data.venue==="uniswap"?"Uniswap Sepolia":"Hyperliquid Testnet"),agentAddress:signer.address,...(data.venue==="uniswap"&&address.toLowerCase()!==user.address.toLowerCase()?{smartAccountAddress:address}:{}),status:"connected",controlRevision:0,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredAccount);
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
  control(user:User,input:{command:string;mode?:"approval-required"|"autonomous";preferences?:string;privateInferenceRequired?:boolean;privateVerification?:"independent-gateway"|"gateway-reported"}){
    const agent=this.agent(user);if(!["pause","resume","take-over","update"].includes(input.command))throw new ApiError("INVALID_CONTROL","Use pause, resume, take-over or update.");
    const paused=input.command==="pause"||input.command==="take-over"?true:input.command==="resume"?false:agent.paused;
    return this.store.db.transaction(()=>{
      const updated=this.store.update<StoredAgent>(user.id,"agent",agent.id,{paused,mode:input.mode??agent.mode,preferences:input.preferences??agent.preferences,privateInferenceRequired:input.privateInferenceRequired??agent.privateInferenceRequired,privateVerification:input.privateVerification??agent.privateVerification??"independent-gateway",controlRevision:agent.controlRevision+1});
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
    const local={...getBudget(this.store,user.id),operatingAddress:this.agent(user).operatingAddress,nativeExpenses:listStorageExpenses(this.store,user.id)};
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
  async permission(user:User,input:{accountId:string;action:string;permissionId?:string;expiresAt?:number;maxTradeUsd?:string;allowedSymbols?:string[];allowedActions?:TradeRequest["type"][];authorization?:unknown}){
    this.expirePermissions(user);
    let account=this.account(user,input.accountId);
    if(input.action==="revoke"||input.action==="rotate"){
      for(const permission of this.store.list<StoredPermission>(user.id,"permission"))if(permission.accountId===account.id&&permission.status!=="revoked")this.store.update<StoredPermission>(user.id,"permission",permission.id,{status:"revoked"});
      const signer=input.action==="rotate"?createSigner(this.store,user.id,`trading:${account.id}`,true):undefined;
      account=this.store.update<StoredAccount>(user.id,"account",account.id,{status:"revoked",controlRevision:account.controlRevision+1,...(signer?{agentAddress:signer.address}:{})});
      return {account,requiresOwnerRevocation:true,message:"Application automation is disabled. Revoke the signer in your venue wallet to remove its native authority."};
    }
    if(input.action==="prepare"){
      const expiresAt=input.expiresAt??Date.now()+86_400_000;if(expiresAt<=Date.now()||expiresAt>Date.now()+(account.venue==="uniswap"?1:30)*86_400_000)throw new ApiError("INVALID_EXPIRY",account.venue==="uniswap"?"Kernel permissions must expire within 24 hours.":"Choose a permission lifetime between now and 30 days.");
      const signer=createSigner(this.store,user.id,`trading:${account.id}`);
      const maxTradeUsd=input.maxTradeUsd??"100";
      if(decimalProductMicros(maxTradeUsd,"1")<=0n)throw new ApiError("INVALID_TRADE_CAP","Set a positive trade cap.");
      const policy=account.venue==="uniswap"?await this.kernelPolicy(account,signer.address,maxTradeUsd,expiresAt):undefined;
      const permission=this.store.put("permission",{id:id(),userId:user.id,accountId:account.id,agentAddress:signer.address,allowedSymbols:input.allowedSymbols??[],allowedActions:input.allowedActions??(account.venue==="uniswap"?["swap"]:["market","limit","cancel","reduce","close","stop-loss","take-profit"]),maxTradeUsd,expiresAt,status:"pending",enforcement:account.venue==="hyperliquid"?"application":"account",controlRevision:account.controlRevision,policy,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredPermission);
      for(const previous of this.store.list<StoredPermission>(user.id,"permission"))if(previous.accountId===account.id&&previous.id!==permission.id&&previous.status==="pending")this.store.update<StoredPermission>(user.id,"permission",previous.id,{status:"revoked",supersededBy:permission.id});
      return {permission,agentAddress:signer.address,agentName:"Orcus Agent",policy,authorization:account.venue==="hyperliquid"?{agentAddress:signer.address,agentName:"Orcus Agent",expiresAfter:expiresAt}:undefined};
    }
    if(input.action!=="activate")throw new ApiError("INVALID_PERMISSION_ACTION","Use prepare, activate, revoke or rotate.");
    const permissions=this.store.list<StoredPermission>(user.id,"permission"),permission=permissions.find(item=>item.accountId===account.id&&item.status==="pending"&&(!input.permissionId||item.id===input.permissionId));
    if(!permission){const active=permissions.find(item=>item.accountId===account.id&&item.status==="active"&&item.expiresAt>Date.now()&&(!input.permissionId||item.id===input.permissionId));if(active&&account.status==="authorized"&&(account.venue==="hyperliquid"||canonicalJson(active.authorization)===canonicalJson(input.authorization)))return{permission:{...active,authorization:undefined},account};}
    if(!permission||permission.expiresAt<=Date.now())throw new ApiError("PERMISSION_EXPIRED","Prepare a new authorization first.");
    if(account.venue==="hyperliquid")await this.verifyHyperliquidApproval(account,permission.agentAddress);
    else await this.verifyKernelApproval(account,permission,input.authorization);
    if(this.account(user,account.id).controlRevision!==permission.controlRevision)throw new ApiError("CONTROL_CHANGED","Account control changed during authorization. Prepare a new grant.",409);
    const active=this.store.update<StoredPermission>(user.id,"permission",permission.id,{status:"active",authorization:input.authorization});
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
  async kernelPolicy(account:StoredAccount,agentAddress:string,maxTradeUsd:string,expiresAt:number):Promise<KernelGrantPolicy>{
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
    return {accountAddress:account.smartAccountAddress,agentAddress,router:cfg.uniswap.router,swaps,issuedAt:Date.now(),expiresAt,maxGasWei:"3000000000000000"};
  }
  async withAccountLease<T>(accountId:string,run:(assertLease:()=>void)=>Promise<T>):Promise<T>{
    const holder=id(),scope=`account:${accountId}`;
    if(!this.store.takeLease(scope,holder,180_000))throw new ApiError("ACCOUNT_BUSY","Another action is reconciling on this account. Refresh before trying again.",409);
    const assertLease=()=>{if(!this.store.renewLease(scope,holder,180_000))throw new ApiError("LEASE_LOST","Account coordination expired. Reconcile before trying another action.",409);};
    const timer=setInterval(()=>{this.store.renewLease(scope,holder,180_000);},30_000);timer.unref();
    try{return await run(assertLease);}finally{clearInterval(timer);this.store.releaseLease(scope,holder);}
  }
  async checkAgentPolicy(user:User,request:TradeRequest,account:StoredAccount):Promise<StoredPermission>{
    const agent=this.agent(user);
    if(agent.paused)throw new ApiError("AGENT_PAUSED","Resume the agent before requesting autonomous actions.",409);
    const permission=this.store.list<StoredPermission>(user.id,"permission").find(item=>item.accountId===account.id&&item.status==="active"&&item.expiresAt>Date.now()&&item.controlRevision===account.controlRevision);
    if(account.status!=="authorized"||!permission)throw new ApiError("AGENT_NOT_AUTHORIZED","Authorize this agent for the selected account first.",403);
    if(permission.allowedSymbols.length&&!permission.allowedSymbols.includes(request.symbol))throw new ApiError("SYMBOL_NOT_AUTHORIZED","This instrument is outside the agent's approved symbols.",403);
    if(!permission.allowedActions.includes(request.type))throw new ApiError("ACTION_NOT_AUTHORIZED","This action is outside the agent's approved permissions.",403);
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
      if(!prepared.expiresAt||prepared.expiresAt<=Date.now())throw new ApiError("QUOTE_EXPIRED","The prepared action expired. Request a new quote.",409);
      const agent=this.agent(user),action=this.store.put("action",{id:actionId,userId:user.id,accountId:account.id,request,status:"awaiting-approval",initiator:initiator!=="manual"?initiator:request.mode==="agent"?"agent":"manual",prepared,controlRevision:account.controlRevision,agentRevision:agent.controlRevision,expiresAt:prepared.expiresAt,providerRequestId,audit:{instruction:instruction.slice(0,10_000),sourceMessageId:context?.messageId,providerRequestId,evaluationId:context?.evaluationId,permission:{decision:permission?"allowed":"owner-signature-required",checkedAt:Date.now(),permissionId:permission?.id,enforcement:permission?.enforcement??"owner",controlRevision:account.controlRevision,agentRevision:agent.controlRevision}},createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredAction);
      return {action,execution:prepared,preview:prepared.quote};
    });
  }
  async submit(user:User,input:{actionId:string;transactionHash?:string;txHash?:string;userOperationHash?:string;orderId?:string;response?:unknown;result?:unknown}){
    let action=this.store.get<StoredAction>(user.id,"action",input.actionId);
    if(!action)throw new ApiError("ACTION_NOT_FOUND","Prepare this action first.",404);
    const lateOwnerEvidence=Boolean(input.transactionHash||input.txHash||input.userOperationHash||input.orderId||input.response||input.result);
    if(terminalStates.has(action.status)&&!(action.status==="cancelled"&&lateOwnerEvidence))return {action};
    const account=this.account(user,action.accountId);
    return this.withAccountLease(account.id,async assertLease=>{
      action=this.store.get<StoredAction>(user.id,"action",input.actionId)!;
      if(terminalStates.has(action.status)&&!(action.status==="cancelled"&&lateOwnerEvidence))return{action};
      const transactionHash=input.transactionHash??input.txHash;
      if(transactionHash&&!/^0x[\da-fA-F]{64}$/.test(transactionHash))throw new ApiError("INVALID_TRANSACTION","Invalid transaction hash.");
      if(input.userOperationHash&&!/^0x[\da-fA-F]{64}$/.test(input.userOperationHash))throw new ApiError("INVALID_USER_OPERATION","Invalid user operation hash.");
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
      const assertAuthority=()=>{
        assertLease();const latest=this.account(user,current.id),latestAgent=this.agent(user),latestPermission=this.store.get<StoredPermission>(user.id,"permission",permission.id);
        if(latest.controlRevision!==action!.controlRevision||latest.status!=="authorized"||latestAgent.paused||latestAgent.controlRevision!==action!.agentRevision||latestPermission?.status!=="active"||latestPermission.expiresAt<=Date.now())throw new ApiError("CONTROL_CHANGED","Authority changed during preparation. No new action was signed.",409);
        if(action!.automationId){const strategy=this.store.get<StoredAutomation>(user.id,"automation",action!.automationId);if(!strategy||strategy.status!=="active"||strategy.policyVersion!==action!.automationPolicyVersion||!action!.evaluationExpiresAt||action!.evaluationExpiresAt<=Date.now())throw new ApiError("STRATEGY_CHANGED","The workflow decision expired or its strategy changed before signing.",409);}
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
        }else {assertAuthority();result=await callEngine("submitAgentAction",fresh,current,key,{assertAuthority});}
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
      const updated=this.store.update<StoredAction>(user.id,"action",action.id,{status:result.status??action.status,transactionHash:result.transactionHash??result.txHash??action.transactionHash,orderId:result.orderId??action.orderId,evidence:result.evidence??action.evidence,error:result.error});
      try{new AgentMemoryStore(this.store,user.id).episode(updated);}catch{}
      return updated;
    }catch(error){return this.store.update<StoredAction>(user.id,"action",action.id,{error:`Reconciliation pending: ${errorMessage(error)}`});}
  }
  async activity(user:User){
    const actions=this.store.list<StoredAction>(user.id,"action",100);
    await Promise.all(actions.filter(action=>["submitting","submitted-unknown","pending","partially-filled"].includes(action.status)).slice(0,10).map(action=>this.reconcile(user,action)));
    return {actions:this.store.list<StoredAction>(user.id,"action",100)};
  }
  async proposal(user:User,message:string,account:StoredAccount|undefined,reference:string,toolProfile:"interactive"|"strategy"="interactive"){
    const cached=this.store.get<Document&{id:string;userId:string;createdAt:number;updatedAt:number}>(user.id,"proposal",reference);
    if(cached){
      if((cached.toolProfile??"interactive")!==toolProfile)throw new ApiError("TOOL_PROFILE_MISMATCH","This proposal belongs to a different tool profile. Start a new authorized evaluation.",409);
      const agent=this.agent(user),result=cached.result as AgentReply,required=agent.privateVerification==="gateway-reported"?"gateway-reported-private":"independently-attested-private";
      if(agent.privateInferenceRequired&&result.privacy!==required)throw new ApiError("PRIVACY_POLICY_CHANGED","This saved result does not satisfy your current private inference policy. Start a new request.",409);
      return result;
    }
    const runtime=new AgentRun(this.store,user.id,reference,message,memoryId=>this.forgetMemory(user,memoryId));runtime.start();
    try{
      const agent=this.agent(user),portfolio=await this.portfolio(user),history=this.store.list<StoredMessage>(user.id,"message",9).reverse();
      if(history.at(-1)?.role==="user"&&history.at(-1)?.content===message)history.pop();
      const result=await callEngine<AgentReply>("planWith0G",message,{...runtime.context(),toolProfile,evaluationId:reference,account,accounts:this.accounts(user),permissions:this.plannerPermissions(user),portfolio,memory:{preferences:agent.preferences,notes:runtime.memory.context(message)},history:history.slice(-8).map(item=>({role:item.role,content:item.content.slice(0,2000)})),requirePrivate:agent.privateInferenceRequired,privateVerification:agent.privateVerification??"independent-gateway"});
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
      this.store.put("proposal",{id:reference,userId:user.id,toolProfile,result,createdAt:Date.now(),updatedAt:Date.now()});
      runtime.complete(result);
      return result;
    }catch(error){
      runtime.fail(error);
      throw error;
    }finally{runtime.close();}
  }
  runStatus(user:User,requestId:string){
    const reference=createHash("sha256").update(`${user.id}|chat|${requestId}`).digest("hex"),run=this.store.get<AgentRunStatus>(user.id,"agent-run",requestId)??this.store.get<AgentRunStatus>(user.id,"agent-run",reference);
    if(!run)throw new ApiError("RUN_NOT_FOUND","This agent run has not started yet.",404);
    const{id,status,stage,tool,modelCalls,toolCalls,startedAt,updatedAt,completedAt,errorCode}=run;
    return{id,status,stage,tool,modelCalls,toolCalls,startedAt,updatedAt,completedAt,errorCode};
  }
  memories(user:User,query?:string){const memory=new AgentMemoryStore(this.store,user.id);return{notes:query?memory.search(query,25):memory.list(50),checkpointAvailable:Boolean(memory.loadCheckpoint(memory.threadId)),warning:"Memory cannot change wallet permissions. Forgetting current notes does not delete existing encrypted 0G backups."};}
  remember(user:User,input:unknown){return new AgentMemoryStore(this.store,user.id).remember(input);}
  forgetMemory(user:User,memoryId:string){
    const memory=new AgentMemoryStore(this.store,user.id),note=memory.get(memoryId);
    if(note?.source==="profile")this.control(user,{command:"update",preferences:""});
    return memory.forget(memoryId)||Boolean(note?.source==="profile");
  }
  async chat(user:User,input:{message:string;accountId?:string;autonomous?:boolean;requestId?:string}){
    rejectMemorySecrets(input.message,{allowPublicHashes:true,code:"CREDENTIAL_INPUT_REJECTED"});
    const reference=input.requestId?createHash("sha256").update(`${user.id}|chat|${input.requestId}`).digest("hex"):id();
    const requestFingerprint=createHash("sha256").update(JSON.stringify({message:input.message,accountId:input.accountId??null,autonomous:input.autonomous??false})).digest("hex");
    const priorUserMessage=this.store.get<StoredMessage>(user.id,"message",`${reference}:user`);
    if(priorUserMessage&&(priorUserMessage.requestFingerprint?priorUserMessage.requestFingerprint!==requestFingerprint:priorUserMessage.content!==input.message))throw new ApiError("IDEMPOTENCY_CONFLICT","This request ID was already used for another chat instruction.",409);
    const priorAssistant=this.store.get<StoredMessage>(user.id,"message",`${reference}:assistant`);
    if(priorAssistant?.actionId){
      const action=this.store.get<StoredAction>(user.id,"action",priorAssistant.actionId);
      if(!action)throw new ApiError("ACTION_RECONCILIATION_REQUIRED","This request was already linked to an execution. Reconcile it before retrying.",409);
      return{message:priorAssistant,proposal:priorAssistant.proposedAction,automationProposal:priorAssistant.automationProposal,runId:reference,requestId:priorAssistant.requestId,action};
    }
    const agent=this.agent(user),account=input.accountId?this.account(user,input.accountId):undefined;
    if(!priorUserMessage)this.store.put("message",{id:`${reference}:user`,userId:user.id,role:"user",content:input.message,requestFingerprint,accountId:input.accountId,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredMessage);
    const result=await this.proposal(user,input.message,account,reference);
    let message:StoredMessage=this.store.put("message",{id:`${reference}:assistant`,userId:user.id,role:"assistant",content:result.message,requestId:result.requestId,proposedAction:result.proposal,automationProposal:result.automationProposal,privacy:result.privacy,privacyEvidence:result.privacyEvidence,createdAt:priorAssistant?.createdAt??Date.now(),updatedAt:Date.now()} satisfies StoredMessage);
    let action:StoredAction|undefined;
    if(result.proposal&&input.autonomous&&agent.mode==="autonomous"&&!agent.paused){
      const prepared=await this.prepare(user,result.proposal,`chat:${reference}`,"agent",{instruction:input.message,providerRequestId:result.requestId,messageId:message.id});
      message=this.store.update<StoredMessage>(user.id,"message",message.id,{actionId:prepared.action.id});
      action=(await this.submit(user,{actionId:prepared.action.id})).action;
    }
    return {message,proposal:result.proposal,automationProposal:result.automationProposal,runId:reference,requestId:result.requestId,requestIds:result.requestIds,modelCalls:result.modelCalls,requiresClarification:result.requiresClarification,action};
  }
  automations(user:User){return {automations:this.store.list<StoredAutomation>(user.id,"automation")};}
  notifications(user:User){const notifications=this.store.list<Document&{readAt?:number}>(user.id,"notification",100);return{notifications,unreadCount:notifications.filter(item=>!item.readAt).length};}
  readNotification(user:User,notificationId:string){return this.store.update<Document&{id:string;userId:string;createdAt:number;updatedAt:number}>(user.id,"notification",notificationId,{readAt:Date.now()});}
  createAutomation(user:User,input:unknown,idempotencyKey?:string){
    const data=automationSchema.parse(input);
    if(data.instruction)rejectMemorySecrets(data.instruction,{allowPublicHashes:true,code:"CREDENTIAL_INPUT_REJECTED"});
    const fingerprint=createHash("sha256").update(canonicalJson(data)).digest("hex"),automationId=idempotencyKey?createHash("sha256").update(`${user.id}|automation|${idempotencyKey}`).digest("hex"):id();
    return this.store.db.transaction(()=>{
    const existing=this.store.get<StoredAutomation>(user.id,"automation",automationId);
    if(existing){if(existing.inputFingerprint!==fingerprint)throw new ApiError("IDEMPOTENCY_CONFLICT","This acceptance ID was already used for a different automation.",409);return existing;}
    const account=this.account(user,data.accountId),agent=this.agent(user);
    if(agent.paused)throw new ApiError("AGENT_PAUSED","Resume the agent before enabling an automation.",409);
    const permission=this.store.list<StoredPermission>(user.id,"permission").find(item=>item.accountId===account.id&&item.status==="active"&&item.expiresAt>Date.now());
    if(data.kind==="trade"&&!permission)throw new ApiError("AGENT_NOT_AUTHORIZED","Authorize agent access before enabling an unattended trading strategy.",403);
    const maximumExpiry=data.kind==="alert"?Date.now()+30*86_400_000:permission!.expiresAt;
    const expiresAt=data.expiresAt??maximumExpiry;
    if(expiresAt<=Date.now()||expiresAt>maximumExpiry)throw new ApiError("INVALID_EXPIRY",data.kind==="alert"?"Alerts must expire within 30 days.":"Strategy expiry must be within its agent permission lifetime.");
    if(data.request&&(data.request.accountId!==account.id||data.request.venue!==account.venue))throw new ApiError("ACCOUNT_MISMATCH","Strategy action belongs to a different account.");
    return this.store.put("automation",{id:automationId,userId:user.id,accountId:account.id,kind:data.kind,name:data.name,instruction:data.instruction??(data.kind==="alert"?"Monitor the approved price condition":"Repeat the explicitly approved trade request"),request:data.request?{...data.request,mode:"agent"}:undefined,condition:data.condition,intervalSeconds:data.intervalSeconds,status:"active",nextRunAt:Date.now(),policyVersion:1,controlRevision:account.controlRevision,inputFingerprint:fingerprint,expiresAt,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredAutomation);
    }).immediate();
  }
  updateAutomation(user:User,automationId:string,input:{status?:"active"|"paused";instruction?:string;intervalSeconds?:number}){
    if(input.instruction)rejectMemorySecrets(input.instruction,{allowPublicHashes:true,code:"CREDENTIAL_INPUT_REJECTED"});
    const automation=this.store.get<StoredAutomation>(user.id,"automation",automationId);if(!automation)throw new ApiError("NOT_FOUND","Automation not found.",404);
    if(input.status==="active"&&(this.agent(user).paused||automation.expiresAt<=Date.now()))throw new ApiError("AUTOMATION_UNAVAILABLE","Resume the agent and renew expired permissions before activating this strategy.",409);
    return this.store.update<StoredAutomation>(user.id,"automation",automationId,{...input,policyVersion:automation.policyVersion+1,nextRunAt:Date.now()});
  }
  async reconcileStorage(user:User,expenseId:string){
    const expense=listStorageExpenses(this.store,user.id).find(item=>item.id===expenseId);
    if(!expense)throw new ApiError("NOT_FOUND","This storage expense does not exist for your account.",404);
    if(expense.status!=="submitted-unknown")return expense;
    return recordStorageExpense(this.store,user.id,await callEngine("reconcileStorageExpense",expense));
  }
  async memory(user:User,action:"backup"|"restore",limits:{maxGas0G?:string;maxStorageFee0G?:string}={}){
    const key=memoryKey(this.store,user.id);
    try{
      if(action==="backup"){
        const longTerm=new AgentMemoryStore(this.store,user.id).snapshot();
        const content={version:2,agent:{preferences:this.agent(user).preferences},messages:this.store.list<StoredMessage>(user.id,"message",16).map(({role,content,createdAt})=>({role,content:content.slice(0,4000),createdAt})),longTerm,capturedAt:Date.now()};
        while(Buffer.byteLength(JSON.stringify(content))>750_000&&content.longTerm.notes.length)content.longTerm.notes.pop();
        if(Buffer.byteLength(JSON.stringify(content))>750_000)throw new ApiError("MEMORY_TOO_LARGE","Compact the active checkpoint before backing up this memory.",413);
        const result=await this.withAccountLease(`operating:${user.id}`,async assertLease=>{
          assertLease();
          if(listStorageExpenses(this.store,user.id).some(expense=>expense.status==="submitted-unknown"))throw new ApiError("STORAGE_OUTCOME_UNKNOWN","Reconcile the previous storage expense before paying for another backup.",409);
          return callEngine<Document>("uploadMemory",content,key,readSigner(this.store,user.id,"operating"),{maxGas0G:limits.maxGas0G??"0.003",maxStorageFee0G:limits.maxStorageFee0G??"0.01",assertAuthority:assertLease,onSubmissionIntent:(expense:unknown)=>{recordStorageExpense(this.store,user.id,expense);},onExpense:(expense:unknown)=>{recordStorageExpense(this.store,user.id,expense);}});
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
      this.store.put("evaluation-run",{id:interrupted.runningEvaluationId!,userId:interrupted.userId,automationId:interrupted.id,accountId:interrupted.accountId,status:"interrupted",reason,createdAt:interrupted.runningStartedAt??Date.now(),updatedAt:Date.now()});
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
        const agent=this.agent(user);
        if(agent.paused||current.expiresAt<=Date.now()){this.store.update<StoredAutomation>(user.id,"automation",current.id,{status:current.expiresAt<=Date.now()?"expired":"paused"});continue;}
        if(this.store.get(user.id,"evaluation",evaluationId)){this.store.update<StoredAutomation>(user.id,"automation",current.id,{status:"failed",error:"This evaluation was already consumed. Review its existing action before resuming."});continue;}
        const account=this.account(user,current.accountId);
        if(account.controlRevision!==current.controlRevision)throw new ApiError("CONTROL_CHANGED","Account control changed. Review this strategy before resuming.",409);
        const alert=current.kind==="alert";
        if(!alert&&!this.store.list<StoredPermission>(user.id,"permission").some(permission=>permission.accountId===account.id&&permission.status==="active"&&permission.expiresAt>Date.now()&&permission.controlRevision===account.controlRevision))throw new ApiError("AGENT_NOT_AUTHORIZED","Renew agent authorization before running this strategy.",403);
        this.store.db.transaction(()=>{
          this.store.update<StoredAutomation>(user.id,"automation",current.id,{runningEvaluationId:evaluationId,runningStartedAt:Date.now(),nextRunAt:Date.now()+current.intervalSeconds*1000,error:undefined});
          this.store.put("evaluation-run",{id:evaluationId,userId:user.id,automationId:current.id,accountId:account.id,status:"running",policyVersion:current.policyVersion,controlRevision:current.controlRevision,createdAt:Date.now(),updatedAt:Date.now()});
        }).immediate();marked=true;
        const assertCurrent=()=>{
          assertTick();
          if(!this.store.renewLease(scope,holder,360_000))throw new ApiError("EVALUATION_LEASE_LOST","Evaluation coordination expired. No new action may use this result.",409);
          const latest=this.store.get<StoredAutomation>(user.id,"automation",current.id),latestAccount=this.account(user,account.id),latestAgent=this.agent(user);
          if(!latest||latest.runningEvaluationId!==evaluationId||latest.policyVersion!==current.policyVersion||latest.status!=="active"||latest.expiresAt<=Date.now()||latest.controlRevision!==current.controlRevision||latestAccount.controlRevision!==account.controlRevision||latestAgent.paused||latestAgent.controlRevision!==agent.controlRevision)throw new ApiError("STRATEGY_CHANGED","Strategy or account authority changed while its workflow was running.",409);
          return latest;
        };
        const planned=alert?{proposal:undefined,requestId:undefined}:current.request?{proposal:current.request,requestId:undefined}:await this.proposal(user,current.instruction,account,evaluationId,"strategy");
        assertCurrent();
        const proposal=planned.proposal;
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
        if(alert){
          if(evaluation.decision==="allow"&&!latest.conditionActive){
            const notificationId=createHash("sha256").update(`${user.id}|alert|${current.id}|${evaluationId}`).digest("hex");
            this.store.put("notification",{id:notificationId,userId:user.id,automationId:current.id,evaluationId,kind:"price-alert",symbol:current.condition?.symbol,message:`${current.name}: ${evaluation.reason}`.slice(0,500),observedAt:evaluation.observedAt,createdAt:Date.now(),updatedAt:Date.now()});
          }
          if(evaluation.decision!=="reject")this.store.update<StoredAutomation>(user.id,"automation",current.id,{conditionActive:evaluation.decision==="allow"});
          results.push({automationId:current.id,evaluationId,decision:evaluation.decision,kind:"alert"});
        }else if(evaluation.decision==="allow"){
          if(!proposal)throw new ApiError("MISSING_PROPOSAL","Workflow allowed no executable proposal.",502);
          const prepared=await this.prepare(user,{...proposal,mode:"agent"},`evaluation:${evaluationId}`,"automation",{instruction:current.instruction,providerRequestId:planned.requestId,evaluationId});
          this.store.update<StoredAction>(user.id,"action",prepared.action.id,{automationId:current.id,automationPolicyVersion:current.policyVersion,evaluationExpiresAt:evaluation.expiresAt});
          const submitted=await this.submit(user,{actionId:prepared.action.id});
          results.push({automationId:current.id,evaluationId,decision:evaluation.decision,actionId:submitted.action.id,status:submitted.action.status});
        }else results.push({automationId:current.id,evaluationId,decision:evaluation.decision});
      }catch(error){
        const latest=this.store.get<StoredAutomation>(user.id,"automation",automation.id);
        if(!latest||marked&&latest.runningEvaluationId!==evaluationId)continue;
        const retryCount=(latest.retryCount??0)+1,busy=!evaluationAccepted&&error instanceof ApiError&&["AGENT_BUSY","ACCOUNT_BUSY","ACCOUNT_RECONCILING"].includes(error.code)&&retryCount<=5;
        if(busy){this.store.update<StoredAutomation>(user.id,"automation",automation.id,{retryCount,nextRunAt:Date.now()+Math.min(300_000,15_000*2**(retryCount-1)),error:errorMessage(error)});results.push({automationId:automation.id,status:"waiting",error:errorMessage(error)});}
        else{const status=latest.status!=="active"?latest.status:error instanceof ApiError&&error.code==="INSUFFICIENT_BUDGET"?"insufficient-budget":"failed";this.store.update<StoredAutomation>(user.id,"automation",automation.id,{status,retryCount,error:errorMessage(error)});results.push({automationId:automation.id,error:errorMessage(error),status});}
      }
      finally{
        const latest=this.store.get<StoredAutomation>(user.id,"automation",automation.id);
        if(marked&&latest?.runningEvaluationId===evaluationId){this.store.update<StoredAutomation>(user.id,"automation",automation.id,{runningEvaluationId:undefined,runningStartedAt:undefined,...(!latest.error?{retryCount:0}:{})});this.store.update<StoredEvaluationRun>(user.id,"evaluation-run",evaluationId,{status:latest.error?"failed":"completed",completedAt:Date.now()});}
        clearInterval(timer);this.store.releaseLease(scope,holder);
      }
    }
    return {processed:results.length,results,reconciled,observedAt:Date.now()};
    }finally{clearInterval(tickTimer);this.store.releaseLease(tickScope,tickHolder);}
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
