import { createHash } from "node:crypto";
import { formatUnits, getAddress, parseUnits } from "viem";
import type { KernelGrantPolicy } from "@orcus/wallets/kernel";
import { tradeRequestSchema,type PreparedAction,type TradeRequest,type User,type Portfolio,type Market,type HealthStatus } from "@orcus/core";
import { z } from "zod";
import { getBudget,reserveBudget,setBudget,settleReservation } from "./budget.js";
import { callEngine } from "./engine.js";
import { ApiError,errorMessage } from "./errors.js";
import { createSigner,memoryKey,readSigner } from "./keystore.js";
import { getStore,id,type Store } from "./store.js";
import type { Document,StoredAccount,StoredAction,StoredAgent,StoredAutomation,StoredMessage,StoredPermission } from "./types.js";

export const accountSchema=z.object({venue:z.enum(["uniswap","hyperliquid"]),address:z.string().optional(),smartAccountAddress:z.string().optional(),chainId:z.number().int().optional(),label:z.string().max(80).optional()}).strict();
export const automationSchema=z.object({accountId:z.string(),name:z.string().min(1).max(80),instruction:z.string().min(1).max(2000),intervalSeconds:z.number().int().min(60).max(86400).default(300),request:tradeRequestSchema.optional(),condition:z.object({symbol:z.string().max(50),operator:z.enum(["above","below"]),price:z.string().regex(/^\d+(?:\.\d+)?$/)}).optional(),expiresAt:z.number().int().optional()}).strict();
const terminalStates=new Set(["confirmed","rejected","cancelled"]);
const evaluationSchema=z.object({id:z.string(),automationId:z.string(),accountId:z.string(),chainId:z.number().int(),decision:z.enum(["allow","reject","no-action"]),reason:z.string(),source:z.literal("local-simulation"),observedAt:z.number().int(),expiresAt:z.number().int(),controlRevision:z.number().int(),policyVersion:z.number().int(),requestId:z.string().optional()}).passthrough();

export class Platform {
  constructor(readonly store:Store=getStore()){}
  agent(user:User):StoredAgent {
    const existing=this.store.list<StoredAgent>(user.id,"agent")[0];if(existing)return existing;
    const operating=createSigner(this.store,user.id,"operating");
    return this.store.put("agent",{id:id(),userId:user.id,name:"My Orcus Agent",operatingAddress:operating.address,paused:false,mode:"approval-required",preferences:"",privateInferenceRequired:false,controlRevision:0,createdAt:Date.now(),updatedAt:Date.now()});
  }
  accounts(user:User){return this.store.list<StoredAccount>(user.id,"account");}
  account(user:User,accountId:string){const account=this.store.get<StoredAccount>(user.id,"account",accountId);if(!account)throw new ApiError("ACCOUNT_NOT_FOUND","Connect this trading account first.",404);return account;}
  session(user:User){return {user,agent:this.agent(user),accounts:this.accounts(user)};}
  agentState(user:User){return {agent:this.agent(user),messages:this.store.list<StoredMessage>(user.id,"message").reverse(),permissions:this.store.list<StoredPermission>(user.id,"permission").map(({authorization,...permission})=>permission)};}
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
  control(user:User,input:{command:string;mode?:"approval-required"|"autonomous";preferences?:string;privateInferenceRequired?:boolean}){
    const agent=this.agent(user);if(!["pause","resume","take-over","update"].includes(input.command))throw new ApiError("INVALID_CONTROL","Use pause, resume, take-over or update.");
    const paused=input.command==="pause"||input.command==="take-over"?true:input.command==="resume"?false:agent.paused;
    return this.store.db.transaction(()=>{
      const updated=this.store.update<StoredAgent>(user.id,"agent",agent.id,{paused,mode:input.mode??agent.mode,preferences:input.preferences??agent.preferences,privateInferenceRequired:input.privateInferenceRequired??agent.privateInferenceRequired,controlRevision:agent.controlRevision+1});
      if(paused){for(const automation of this.store.list<StoredAutomation>(user.id,"automation"))if(automation.status==="active")this.store.update<StoredAutomation>(user.id,"automation",automation.id,{status:"paused"});for(const action of this.store.list<StoredAction>(user.id,"action"))if(["prepared","awaiting-approval"].includes(action.status)&&action.initiator!=="manual")this.store.update<StoredAction>(user.id,"action",action.id,{status:"cancelled",error:"Agent paused or owner took over before submission."});}
      return {agent:updated,inFlight:this.store.list<StoredAction>(user.id,"action").filter(action=>["submitting","submitted-unknown","pending","partially-filled"].includes(action.status))};
    })();
  }
  budget(user:User){return {...getBudget(this.store,user.id),operatingAddress:this.agent(user).operatingAddress};}
  setBudget(user:User,input:{limitUsd?:string;capUsd?:string;lowBalanceUsd?:string;autoReplenish?:boolean}){
    const previous=getBudget(this.store,user.id);setBudget(this.store,user.id,input.limitUsd??input.capUsd??previous.limitUsd,input.lowBalanceUsd??previous.lowBalanceUsd,input.autoReplenish??previous.autoReplenish);return this.budget(user);
  }
  async permission(user:User,input:{accountId:string;action:string;expiresAt?:number;maxTradeUsd?:string;allowedSymbols?:string[];allowedActions?:TradeRequest["type"][];authorization?:unknown}){
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
      return {permission,agentAddress:signer.address,agentName:"Orcus Agent",policy,authorization:account.venue==="hyperliquid"?{agentAddress:signer.address,agentName:"Orcus Agent",expiresAfter:expiresAt}:undefined};
    }
    if(input.action!=="activate")throw new ApiError("INVALID_PERMISSION_ACTION","Use prepare, activate, revoke or rotate.");
    const permission=this.store.list<StoredPermission>(user.id,"permission").find(item=>item.accountId===account.id&&item.status==="pending");
    if(!permission||permission.expiresAt<=Date.now())throw new ApiError("PERMISSION_EXPIRED","Prepare a new authorization first.");
    if(account.venue==="hyperliquid")await this.verifyHyperliquidApproval(account,permission.agentAddress);
    else await this.verifyKernelApproval(account,permission,input.authorization);
    if(this.account(user,account.id).controlRevision!==permission.controlRevision)throw new ApiError("CONTROL_CHANGED","Account control changed during authorization. Prepare a new grant.",409);
    const active=this.store.update<StoredPermission>(user.id,"permission",permission.id,{status:"active",authorization:input.authorization});
    this.store.update<StoredAccount>(user.id,"account",account.id,{status:"authorized"});
    return {permission:{...active,authorization:undefined},account:this.account(user,account.id)};
  }
  async verifyHyperliquidApproval(account:StoredAccount,agentAddress:string){
    const response=await fetch("https://api.hyperliquid-testnet.xyz/info",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"extraAgents",user:account.ownerAddress}),signal:AbortSignal.timeout(12_000)});
    if(!response.ok)throw new ApiError("VENUE_UNAVAILABLE","Could not verify Hyperliquid agent approval.",503);
    const agents=await response.json() as {address?:string;validUntil?:number}[];
    if(!Array.isArray(agents)||!agents.some(agent=>agent.address?.toLowerCase()===agentAddress.toLowerCase()&&(!agent.validUntil||agent.validUntil>Date.now())))throw new ApiError("AGENT_NOT_APPROVED","Approve this agent in your Hyperliquid owner wallet first.",409);
  }
  async verifyKernelApproval(account:StoredAccount,permission:StoredPermission,authorization:unknown){
    if(!permission.policy||JSON.stringify((authorization as {policy?:unknown}|undefined)?.policy)!==JSON.stringify(permission.policy))throw new ApiError("INVALID_SESSION_POLICY","Approve the exact bounded policy prepared for this account.",403);
    const packageName="@orcus/wallets/server";const wallets=await import(packageName) as Record<string,unknown>;
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
  async prepare(user:User,input:unknown,idempotencyKey?:string,initiator:"manual"|"agent"|"automation"="manual"){
    const request=tradeRequestSchema.parse(input),account=this.account(user,request.accountId);
    if(request.venue!==account.venue)throw new ApiError("VENUE_MISMATCH","Action venue does not match the selected account.");
    const actionId=idempotencyKey?createHash("sha256").update(`${user.id}|${idempotencyKey}`).digest("hex"):id();
    const previous=this.store.get<StoredAction>(user.id,"action",actionId);
    if(previous){if(JSON.stringify(previous.request)!==JSON.stringify(request))throw new ApiError("IDEMPOTENCY_CONFLICT","This action ID was already used for a different request.",409);return {action:previous,execution:previous.prepared,preview:previous.prepared.quote};}
    return this.withAccountLease(account.id,async()=>{
      if(request.mode==="agent"){
        for(const uncertain of this.store.list<StoredAction>(user.id,"action").filter(item=>item.accountId===account.id&&["submitting","submitted-unknown"].includes(item.status))){
          const reconciled=await this.reconcile(user,uncertain);
          if(["submitting","submitted-unknown"].includes(reconciled.status))throw new ApiError("ACCOUNT_RECONCILING","A previous action still has an unknown venue outcome. Reconcile it before another autonomous trade.",409);
        }
        await this.checkAgentPolicy(user,request,account);
      }
      const prepared=await callEngine<PreparedAction>("prepareAction",request,account);
      prepared.id=actionId;prepared.request=tradeRequestSchema.parse({...prepared.request,accountId:account.id,venue:account.venue,mode:request.mode});prepared.account=account;prepared.controlRevision=account.controlRevision;
      if(!prepared.expiresAt||prepared.expiresAt<=Date.now())throw new ApiError("QUOTE_EXPIRED","The prepared action expired. Request a new quote.",409);
      const agent=this.agent(user),action=this.store.put("action",{id:actionId,userId:user.id,accountId:account.id,request,status:"awaiting-approval",initiator:request.mode==="manual"?"manual":initiator==="manual"?"agent":initiator,prepared,controlRevision:account.controlRevision,agentRevision:agent.controlRevision,expiresAt:prepared.expiresAt,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredAction);
      return {action,execution:prepared,preview:prepared.quote};
    });
  }
  async submit(user:User,input:{actionId:string;transactionHash?:string;txHash?:string;userOperationHash?:string;orderId?:string;response?:unknown;result?:unknown}){
    let action=this.store.get<StoredAction>(user.id,"action",input.actionId);
    if(!action)throw new ApiError("ACTION_NOT_FOUND","Prepare this action first.",404);
    if(terminalStates.has(action.status))return {action};
    const account=this.account(user,action.accountId);
    return this.withAccountLease(account.id,async assertLease=>{
      action=this.store.get<StoredAction>(user.id,"action",input.actionId)!;
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
          const packageName="@orcus/wallets/server",wallets=await import(packageName) as Record<string,unknown>;
          if(typeof wallets.submitKernelSessionAction!=="function")throw new ApiError("SESSION_UNCONFIGURED","Kernel delegated execution is not configured.",503);
          assertAuthority();
          result=await (wallets.submitKernelSessionAction as (...args:unknown[])=>Promise<typeof result>)(fresh,key,permission.authorization,(evidence:{userOperationHash:string})=>{action=this.store.update<StoredAction>(user.id,"action",action!.id,{status:"pending",userOperationHash:evidence.userOperationHash});});
        }else {assertAuthority();result=await callEngine("submitAgentAction",fresh,current,key);}
        action=this.store.update<StoredAction>(user.id,"action",action.id,{status:result.status??"pending",transactionHash:result.transactionHash??result.txHash??action.transactionHash,userOperationHash:result.userOperationHash??action.userOperationHash,orderId:result.orderId,evidence:result.evidence});
        return {action:await this.reconcile(user,action)};
      }catch(error){
        const knownPreflight=error instanceof ApiError&&["SESSION_UNCONFIGURED","INVALID_SESSION_APPROVAL","AGENT_NOT_AUTHORIZED","TRADE_LIMIT"].includes(error.code);
        this.store.update<StoredAction>(user.id,"action",action.id,{status:knownPreflight?"rejected":"submitted-unknown",error:errorMessage(error)});
        throw error;
      }
    });
  }
  async reconcile(user:User,action:StoredAction):Promise<StoredAction>{
    try{
      const result=await callEngine<{status?:StoredAction["status"];transactionHash?:string;txHash?:string;orderId?:string;evidence?:unknown;error?:string}>("reconcileAction",{...action,txHash:action.transactionHash},this.account(user,action.accountId));
      return this.store.update<StoredAction>(user.id,"action",action.id,{status:result.status??action.status,transactionHash:result.transactionHash??result.txHash??action.transactionHash,orderId:result.orderId??action.orderId,evidence:result.evidence??action.evidence,error:result.error});
    }catch(error){return this.store.update<StoredAction>(user.id,"action",action.id,{error:`Reconciliation pending: ${errorMessage(error)}`});}
  }
  async activity(user:User){
    const actions=this.store.list<StoredAction>(user.id,"action",100);
    await Promise.all(actions.filter(action=>["submitting","submitted-unknown","pending","partially-filled"].includes(action.status)).slice(0,10).map(action=>this.reconcile(user,action)));
    return {actions:this.store.list<StoredAction>(user.id,"action",100)};
  }
  async proposal(user:User,message:string,account:StoredAccount|undefined,reference:string){
    const cached=this.store.get<Document&{id:string;userId:string;createdAt:number;updatedAt:number}>(user.id,"proposal",reference);
    if(cached)return cached.result as {message:string;proposal?:TradeRequest;requestId?:string;usage?:unknown;requiresClarification?:boolean};
    if(!reserveBudget(this.store,user.id,reference,process.env.ORCUS_COMPUTE_RESERVATION_USD??"0.01"))throw new ApiError("EVALUATION_PENDING","This inference request is already pending or needs billing reconciliation. It will not be charged again automatically.",409);
    try{
      const agent=this.agent(user),portfolio=await this.portfolio(user),history=this.store.list<StoredMessage>(user.id,"message",20).reverse();
      const result=await callEngine<{message:string;proposal?:TradeRequest;requestId?:string;usage?:unknown;costUsd?:string;requiresClarification?:boolean}>("planWith0G",message,{evaluationId:reference,account,accounts:this.accounts(user),portfolio,memory:{preferences:agent.preferences},history:history.map(item=>({role:item.role,content:item.content})),requirePrivate:agent.privateInferenceRequired});
      if(typeof result.message!=="string"||!result.message.trim())throw new ApiError("INVALID_AI_RESULT","The model did not return a valid response. No action was taken.",502);
      if(result.proposal){
        const selected=account??(this.accounts(user).length===1?this.accounts(user)[0]:undefined);
        if(!selected){delete result.proposal;result.requiresClarification=true;result.message="Select which trading account this instruction applies to. No action was taken.";}
        else result.proposal=tradeRequestSchema.parse({...result.proposal,accountId:selected.id,venue:selected.venue,mode:"agent"});
      }
      this.store.put("proposal",{id:reference,userId:user.id,result,createdAt:Date.now(),updatedAt:Date.now()});
      settleReservation(this.store,user.id,reference,result.costUsd!==undefined?"settled":"unknown",{requestId:result.requestId,usage:result.usage,billing:result.costUsd===undefined?"Provider cost unavailable; reservation retained.":"provider-reported"},result.costUsd);
      return result;
    }catch(error){
      const beforeCall=error instanceof ApiError&&["COMPUTE_UNCONFIGURED","PRIVATE_INFERENCE_UNAVAILABLE","PRIVATE_INFERENCE_UNVERIFIED","INTEGRATION_UNCONFIGURED","NOT_CONFIGURED","INVALID_MESSAGE"].includes(error.code);
      settleReservation(this.store,user.id,reference,beforeCall?"released":"unknown",{message:beforeCall?"Request was not sent.":"Provider usage may be billable; automatic duplicate retry disabled."});
      throw error;
    }
  }
  async chat(user:User,input:{message:string;accountId?:string;autonomous?:boolean;requestId?:string}){
    const reference=input.requestId?createHash("sha256").update(`${user.id}|chat|${input.requestId}`).digest("hex"):id();
    const agent=this.agent(user),account=input.accountId?this.account(user,input.accountId):undefined;
    if(!this.store.get(user.id,"message",`${reference}:user`))this.store.put("message",{id:`${reference}:user`,userId:user.id,role:"user",content:input.message,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredMessage);
    const result=await this.proposal(user,input.message,account,reference);
    const message=this.store.put("message",{id:`${reference}:assistant`,userId:user.id,role:"assistant",content:result.message,requestId:result.requestId,proposedAction:result.proposal,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredMessage);
    let action:StoredAction|undefined;
    if(result.proposal&&input.autonomous&&agent.mode==="autonomous"&&!agent.paused){
      const prepared=await this.prepare(user,result.proposal,`chat:${reference}`,"agent");
      action=(await this.submit(user,{actionId:prepared.action.id})).action;
    }
    return {message,proposal:result.proposal,requestId:result.requestId,requiresClarification:result.requiresClarification,action};
  }
  automations(user:User){return {automations:this.store.list<StoredAutomation>(user.id,"automation")};}
  createAutomation(user:User,input:unknown){
    const data=automationSchema.parse(input),account=this.account(user,data.accountId),agent=this.agent(user);
    if(agent.paused)throw new ApiError("AGENT_PAUSED","Resume the agent before enabling an automation.",409);
    const permission=this.store.list<StoredPermission>(user.id,"permission").find(item=>item.accountId===account.id&&item.status==="active"&&item.expiresAt>Date.now());
    if(!permission)throw new ApiError("AGENT_NOT_AUTHORIZED","Authorize agent access before enabling an unattended strategy.",403);
    const expiresAt=data.expiresAt??permission.expiresAt;
    if(expiresAt<=Date.now()||expiresAt>permission.expiresAt)throw new ApiError("INVALID_EXPIRY","Strategy expiry must be within its agent permission lifetime.");
    if(data.request&&(data.request.accountId!==account.id||data.request.venue!==account.venue))throw new ApiError("ACCOUNT_MISMATCH","Strategy action belongs to a different account.");
    return this.store.put("automation",{id:id(),userId:user.id,accountId:account.id,name:data.name,instruction:data.instruction,request:data.request?{...data.request,mode:"agent"}:undefined,condition:data.condition,intervalSeconds:data.intervalSeconds,status:"active",nextRunAt:Date.now(),policyVersion:1,controlRevision:account.controlRevision,expiresAt,createdAt:Date.now(),updatedAt:Date.now()} satisfies StoredAutomation);
  }
  updateAutomation(user:User,automationId:string,input:{status?:"active"|"paused";instruction?:string;intervalSeconds?:number}){
    const automation=this.store.get<StoredAutomation>(user.id,"automation",automationId);if(!automation)throw new ApiError("NOT_FOUND","Automation not found.",404);
    if(input.status==="active"&&(this.agent(user).paused||automation.expiresAt<=Date.now()))throw new ApiError("AUTOMATION_UNAVAILABLE","Resume the agent and renew expired permissions before activating this strategy.",409);
    return this.store.update<StoredAutomation>(user.id,"automation",automationId,{...input,policyVersion:automation.policyVersion+1,nextRunAt:Date.now()});
  }
  async memory(user:User,action:"backup"|"restore"){
    const key=memoryKey(this.store,user.id);
    try{
      if(action==="backup"){
        const content={version:1,agent:{preferences:this.agent(user).preferences},messages:this.store.list<StoredMessage>(user.id,"message",100).map(({role,content,createdAt})=>({role,content,createdAt}))};
        const result=await callEngine<Document>("uploadMemory",content,key,readSigner(this.store,user.id,"operating"));
        const rootHash=result.rootHash??result.root;
        if(typeof rootHash!=="string")throw new ApiError("STORAGE_UNCONFIRMED","Storage did not confirm an uploaded root. No backup was marked successful.",502);
        return this.store.put("memory",{id:id(),userId:user.id,rootHash,status:"confirmed",evidence:result,createdAt:Date.now(),updatedAt:Date.now()});
      }
      const backup=this.store.list<Document&{rootHash:string}>(user.id,"memory")[0];if(!backup)throw new ApiError("MEMORY_NOT_FOUND","Create a confirmed encrypted backup first.",404);
      const content=await callEngine<{version:number;agent?:{preferences?:string};messages?:{role:string;content:string;createdAt:number}[]}>("downloadMemory",backup.rootHash,key);
      if(content.version!==1||!Array.isArray(content.messages)||content.messages.length>100)throw new ApiError("INVALID_MEMORY","Downloaded memory has an unsupported schema.",502);
      if(typeof content.agent?.preferences==="string")this.store.update<StoredAgent>(user.id,"agent",this.agent(user).id,{preferences:content.agent.preferences});
      for(const item of content.messages){if(!["user","assistant"].includes(item.role)||typeof item.content!=="string"||item.content.length>20_000)throw new ApiError("INVALID_MEMORY","Downloaded memory contains invalid conversation data.",502);const messageId=createHash("sha256").update(`${user.id}|${item.role}|${item.content}|${item.createdAt}`).digest("hex");this.store.put("message",{id:messageId,userId:user.id,role:item.role as "user"|"assistant",content:item.content,createdAt:item.createdAt,updatedAt:Date.now()});}
      return {restored:true,messageCount:content.messages.length,rootHash:backup.rootHash};
    }finally{key.fill(0);}
  }
  async tick(){
    const results:Document[]=[];
    for(const automation of this.store.dueAutomations<StoredAutomation>(3)){
      const evaluationId=createHash("sha256").update(`${automation.id}|${automation.nextRunAt}|${automation.policyVersion}`).digest("hex"),holder=id(),scope=`evaluation:${automation.id}`;
      if(!this.store.takeLease(scope,holder,360_000))continue;
      const timer=setInterval(()=>{this.store.renewLease(scope,holder,360_000);},30_000);timer.unref();
      const row=this.store.db.prepare("SELECT * FROM users WHERE id=?").get(automation.userId) as {id:string;address:string;created_at:number}|undefined;
      if(!row){clearInterval(timer);this.store.releaseLease(scope,holder);continue;}
      const user:User={id:row.id,address:row.address,createdAt:row.created_at};
      try{
        const current=this.store.get<StoredAutomation>(user.id,"automation",automation.id)!;
        if(current.status!=="active"||current.nextRunAt>Date.now())continue;
        if(this.agent(user).paused||current.expiresAt<=Date.now()){this.store.update<StoredAutomation>(user.id,"automation",current.id,{status:current.expiresAt<=Date.now()?"expired":"paused"});continue;}
        if(this.store.get(user.id,"evaluation",evaluationId))continue;
        const account=this.account(user,current.accountId);
        if(account.controlRevision!==current.controlRevision)throw new ApiError("CONTROL_CHANGED","Account control changed. Review this strategy before resuming.",409);
        this.store.update<StoredAutomation>(user.id,"automation",current.id,{nextRunAt:Date.now()+current.intervalSeconds*1000});
        const planned=current.request?{proposal:current.request,requestId:undefined}:await this.proposal(user,current.instruction,account,evaluationId);
        const proposal=planned.proposal;
        if(!proposal){
          this.store.put("evaluation",{id:evaluationId,userId:user.id,automationId:current.id,accountId:account.id,decision:"no-action",source:"planner",reason:"No executable proposal was returned. CRE was not invoked and no trade was authorized.",requestId:planned.requestId,createdAt:Date.now(),updatedAt:Date.now()});
          results.push({automationId:current.id,evaluationId,decision:"no-action",source:"planner"});
          continue;
        }
        const raw=await callEngine<Document>("evaluateStrategy",{evaluationId,automationId:current.id,account,request:proposal,proposal,requestId:planned.requestId,instruction:current.instruction,condition:current.condition,controlRevision:current.controlRevision,policyVersion:current.policyVersion,expiresAt:Math.min(current.expiresAt,Date.now()+120_000)});
        const evaluation=evaluationSchema.parse({...raw,id:raw.id??raw.evaluationId});
        if(evaluation.id!==evaluationId||evaluation.automationId!==current.id||evaluation.accountId!==account.id||evaluation.chainId!==account.chainId||evaluation.controlRevision!==account.controlRevision||evaluation.policyVersion!==current.policyVersion||evaluation.requestId!==planned.requestId||evaluation.expiresAt<=Date.now()||evaluation.observedAt>Date.now()+5000||Date.now()-evaluation.observedAt>120_000)throw new ApiError("INVALID_CRE_RESULT","Workflow result is stale, unbound or not an authenticated local simulation.",502);
        const latest=this.store.get<StoredAutomation>(user.id,"automation",current.id)!;
        if(latest.policyVersion!==current.policyVersion||latest.status!=="active"||this.agent(user).paused)throw new ApiError("STRATEGY_CHANGED","Strategy changed while its workflow was running.",409);
        this.store.put("evaluation",{...evaluation,id:evaluationId,userId:user.id,createdAt:Date.now(),updatedAt:Date.now()});
        this.store.update<StoredAutomation>(user.id,"automation",current.id,{lastEvaluation:evaluation as unknown as StoredAutomation["lastEvaluation"]});
        if(evaluation.decision==="allow"){
          if(!proposal)throw new ApiError("MISSING_PROPOSAL","Workflow allowed no executable proposal.",502);
          const prepared=await this.prepare(user,{...proposal,mode:"agent"},`evaluation:${evaluationId}`,"automation");
          this.store.update<StoredAction>(user.id,"action",prepared.action.id,{automationId:current.id,automationPolicyVersion:current.policyVersion,evaluationExpiresAt:evaluation.expiresAt});
          const submitted=await this.submit(user,{actionId:prepared.action.id});
          results.push({automationId:current.id,evaluationId,decision:evaluation.decision,actionId:submitted.action.id,status:submitted.action.status});
        }else results.push({automationId:current.id,evaluationId,decision:evaluation.decision});
      }catch(error){const status=error instanceof ApiError&&error.code==="INSUFFICIENT_BUDGET"?"insufficient-budget":"failed";this.store.update<StoredAutomation>(user.id,"automation",automation.id,{status,error:errorMessage(error)});results.push({automationId:automation.id,error:errorMessage(error),status});}
      finally{clearInterval(timer);this.store.releaseLease(scope,holder);}
    }
    return {processed:results.length,results,observedAt:Date.now()};
  }
}

function decimalProductMicros(a:string,b:string):bigint{
  if(!/^\d+(?:\.\d+)?$/.test(a)||!/^\d+(?:\.\d+)?$/.test(b)||a.length>80||b.length>80)throw new ApiError("INVALID_AMOUNT","Invalid exact decimal amount.");
  const [aw,af=""]=a.split("."),[bw,bf=""]=b.split("."),scale=10n**BigInt(af.length+bf.length),product=BigInt(aw+af)*BigInt(bw+bf)*1_000_000n;
  return (product+scale-1n)/scale;
}
