import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData,erc20Abi,parseUnits } from "viem";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { tradeRequestSchema,type OstiumAllowanceIntent,type OstiumExecution,type PreparedAction } from "@orcus/core";
import * as boundary from "./engine";
import { handleRequest } from "./http";
import { cancelOstiumAllowance,listOstiumAllowances,prepareOstiumAllowance,reconcileOstiumAllowance,submitOstiumAllowance } from "./ostium-allowances";
import { ostiumAcknowledgement,ostiumAuthorization,validateOstiumExecution } from "./ostium-policy";
import { Platform } from "./platform";
import { Store } from "./store";
import type { StoredAction,StoredPermission } from "./types";

const owner=`0x${"1".repeat(40)}`,foreign=`0x${"2".repeat(40)}`,token=`0x${"3".repeat(40)}`,contract=`0x${"4".repeat(40)}`,implementation=`0x${"5".repeat(40)}`,zero=`0x${"0".repeat(40)}`;
const approvalHash=`0x${"a".repeat(64)}`,tradeHash=`0x${"b".repeat(64)}`,origin="http://localhost:3186";
let directory:string,stores:Store[]=[];
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),"orcus-ostium-boundary-"));vi.stubEnv("ORCUS_DATA_DIR",directory);vi.stubEnv("ORCUS_APP_URL",origin);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const store of stores)if(store.db.open)store.db.close();stores=[];rmSync(directory,{recursive:true,force:true});});

function harness(persistent=false){
  const path=persistent?join(directory,"platform.sqlite"):":memory:",store=new Store(path);stores.push(store);
  const user=store.ensureUser(owner),platform=new Platform(store),account=platform.createAccount(user,{venue:"ostium"});
  let delegate=zero,approvalStatus="confirmed",nativeStatus="confirmed",includeApproval=false;
  const approval=(amount="10")=>({to:token,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[contract as`0x${string}`,parseUnits(amount,6)]}),value:"0",chainId:421614});
  const request=(change:Record<string,unknown>={})=>tradeRequestSchema.parse({accountId:account.id,venue:"ostium",type:"market",symbol:"XAU/USD",side:"buy",amount:"10",amountUnit:"collateral-usdc",leverage:10,...change});
  const prepared=(input=request()):PreparedAction=>({id:"fixture",request:input,account,kind:"evm",expiresAt:Date.now()+60_000,controlRevision:account.controlRevision,transactions:[...(includeApproval?[approval()]:[]),{to:contract,data:"0x12345678",value:"0",chainId:421614}],ostium:{trader:owner,recipient:owner,chainId:421614,pairId:17,symbol:input.symbol,positionId:input.positionId,amountUnit:input.amountUnit??"collateral-usdc",requiredAllowanceUsd:"10",collateralUsd:"10",notionalUsd:"100",leverage:input.leverage??10,builderFeeBps:0,marketObservedAt:Date.now(),minimumBlock:"100",functionName:"openTrade",expectedData:"0x12345678",delegate:input.mode==="agent"?account.agentAddress:undefined}});
  const ack=(agentAddress=account.agentAddress)=>({ostiumAcknowledgement:{version:"ostium-native-delegation-v1",chainId:421614,trader:owner,agentAddress,nativeNoExpiry:true,applicationLimitsOnly:true,delegateCanRemoveCollateral:true,delegateCanChargeBuilderFees:true,ownerOnlyPermissionChanges:true,payoutsToOwner:true}});
  const engine=vi.spyOn(boundary,"callEngine").mockImplementation(async(name,...args)=>{
    if(name==="getOstiumAuthorization")return{trader:owner,delegate,chainId:421614,contractAddress:contract,implementation,observedAt:Date.now(),blockNumber:"100"};
    if(name==="getOstiumDelegationTransactions")return{trader:owner,delegate:args[1],chainId:421614,contractAddress:contract,currentDelegate:delegate,implementation,transactions:[],expiresAt:Date.now()+60_000,alreadyActive:false};
    if(name==="getOstiumApprovalTransaction"){const amount=String(args[1]);return{trader:owner,chainId:421614,token,spender:contract,amountUsd:amount,amountRaw:parseUnits(amount,6).toString(),transaction:approval(amount),previousAllowanceUsd:"0",expiresAt:Date.now()+60_000,minimumBlock:"100"};}
    if(name==="reconcileOstiumApproval")return{status:approvalStatus,transactionHash:(args[0]as{transactionHash:string}).transactionHash};
    if(name==="prepareAction")return prepared(tradeRequestSchema.parse(args[0]));
    if(name==="submitAgentAction"){const options=args[3]as{assertAuthority?:(action?:PreparedAction)=>void;onSubmitted?:(evidence:unknown)=>void};options.assertAuthority?.(args[0]as PreparedAction);options.onSubmitted?.({transactionHash:tradeHash,step:"trade"});return{status:"pending",transactionHash:tradeHash};}
    if(name==="reconcileAction")return{status:nativeStatus,transactionHash:(args[0]as StoredAction).transactionHash};
    if(name==="getOstiumHistory")return{trades:[],observedAt:Date.now()};
    throw new Error(`Unexpected fixture engine call ${name}`);
  });
  const activate=async(change:Record<string,unknown>={})=>{const grant=await platform.permission(user,{accountId:account.id,action:"prepare",...change});delegate=account.agentAddress!;await platform.permission(user,{accountId:account.id,action:"activate",permissionId:grant.permission!.id,authorization:ack()});return store.get<StoredPermission>(user.id,"permission",grant.permission!.id)!;};
  const challenge=store.createChallenge(owner,origin),session=store.createSession(challenge.id,owner);
  const http=async(route:string,body?:unknown)=>{const response=await handleRequest(new Request(`${origin}/api/${route}`,{method:body?"POST":"GET",headers:{Origin:origin,Cookie:`orcus_session=${session.token}`,...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})}),store);return{status:response.status,body:await response.json()};};
  return{path,store,user,platform,account,engine,request,prepared,ack,activate,http,setDelegate:(value:string)=>{delegate=value;},setApprovalStatus:(value:string)=>{approvalStatus=value;},setNativeStatus:(value:string)=>{nativeStatus=value;},includeApproval:()=>{includeApproval=true;}};
}

describe("Ostium native authority and deterministic application policy",()=>{
  it("requires the actual owner account, native delegate and explicit broader-rights acknowledgement",async()=>{
    const h=harness();
    expect(()=>h.platform.createAccount(h.user,{venue:"ostium",address:foreign})).toThrow(/connected owner/);
    expect(()=>h.platform.createAccount(h.user,{venue:"ostium",chainId:42161})).toThrow(/configured/);
    const grant=await h.platform.permission(h.user,{accountId:h.account.id,action:"prepare"});
    expect(grant.permission).toMatchObject({maxTradeUsd:"100",maxCollateralUsd:"100",maxLeverage:20,enforcement:"application"});
    await expect(h.platform.permission(h.user,{accountId:h.account.id,action:"activate",permissionId:grant.permission!.id})).rejects.toMatchObject({code:"OSTIUM_ACKNOWLEDGEMENT_REQUIRED"});
    expect(()=>ostiumAcknowledgement(h.account,h.account.agentAddress!,h.ack(foreign))).toThrow(/Explicitly acknowledge/);
    await expect(h.platform.permission(h.user,{accountId:h.account.id,action:"activate",permissionId:grant.permission!.id,authorization:h.ack()})).rejects.toMatchObject({code:"AGENT_NOT_APPROVED"});
    h.setDelegate(h.account.agentAddress!);
    expect((await h.platform.permission(h.user,{accountId:h.account.id,action:"activate",permissionId:grant.permission!.id,authorization:h.ack()})).account!.status).toBe("authorized");
    h.setDelegate(foreign);
    await expect(h.platform.permission(h.user,{accountId:h.account.id,action:"activate",permissionId:grant.permission!.id,authorization:h.ack()})).rejects.toMatchObject({code:"AGENT_NOT_APPROVED"});
  });
  it("never replaces another native delegate and app revocation survives an unavailable native read",async()=>{
    const h=harness();h.setDelegate(foreign);
    await expect(h.platform.permission(h.user,{accountId:h.account.id,action:"prepare"})).rejects.toMatchObject({code:"OSTIUM_DELEGATE_EXISTS"});
    expect(h.engine.mock.calls.some(([name])=>name==="getOstiumDelegationTransactions")).toBe(false);
    const unrelated=await h.platform.permission(h.user,{accountId:h.account.id,action:"revoke"});
    expect(unrelated).toMatchObject({requiresOwnerRevocation:false});expect(unrelated.ostium).toBeUndefined();
    h.setDelegate(zero);await h.activate();h.engine.mockRejectedValue(new Error("Unavailable fixture RPC"));
    const disabled=await h.platform.permission(h.user,{accountId:h.account.id,action:"revoke"});
    expect(disabled.account!.status).toBe("revoked");expect(disabled.requiresOwnerRevocation).toBe(true);expect(h.platform.agentState(h.user).permissions.every(item=>item.status==="revoked")).toBe(true);
  });
  it("returns an owner-only native revoke plan for a managed signer after rotation",async()=>{
    const h=harness();await h.activate();
    const disabled=await h.platform.permission(h.user,{accountId:h.account.id,action:"rotate"});
    expect(disabled.requiresOwnerRevocation).toBe(true);expect(disabled.ostium).toMatchObject({delegate:null});
    expect(disabled.account!.agentAddress).not.toBe(h.account.agentAddress);
  });
  it("fails closed on stale native observations and wrong network or trader",async()=>{
    const h=harness(),valid={trader:owner,delegate:h.account.agentAddress,chainId:421614,contractAddress:contract,implementation,observedAt:Date.now()};
    for(const change of[{observedAt:Date.now()-31_000},{observedAt:Date.now()+6_000},{trader:foreign},{chainId:42161}]){
      h.engine.mockResolvedValue({...valid,...change});await expect(ostiumAuthorization(h.account)).rejects.toMatchObject({code:"OSTIUM_AUTHORITY_UNVERIFIED"});
    }
  });
  it("checks actual normalized risk rather than the model's placeholder amount",async()=>{
    const h=harness(),permission=await h.activate({maxTradeUsd:"100",maxCollateralUsd:"20",maxLeverage:10}),base=h.prepared(h.request({mode:"agent"}));
    expect(validateOstiumExecution(base,h.account,permission).notionalUsd).toBe("100");
    for(const[change,code]of[[{notionalUsd:"100.0000001"},"TRADE_LIMIT"],[{collateralUsd:"20.000001"},"COLLATERAL_LIMIT"],[{requiredAllowanceUsd:"20.000001"},"COLLATERAL_LIMIT"],[{leverage:10.01},"LEVERAGE_LIMIT"]]as const)expect(()=>validateOstiumExecution({...base,ostium:{...base.ostium!,...change}},h.account,permission)).toThrow(expect.objectContaining({code}));
    const previous=h.engine.getMockImplementation()!;
    h.engine.mockImplementation(async(name,...args)=>name==="prepareAction"?{...base,request:h.request({mode:"agent",type:"close",positionId:"native-position",amountUnit:"base",amount:"0.0001"}),ostium:{...base.ostium,positionId:"native-position",amountUnit:"base",notionalUsd:"500"}}:previous(name,...args));
    await expect(h.platform.prepare(h.user,h.request({mode:"agent",type:"close",positionId:"native-position",amountUnit:"base",amount:"0.0001"}))).rejects.toMatchObject({code:"TRADE_LIMIT"});
    expect(h.store.list(h.user.id,"action")).toHaveLength(0);
  });
  it.each([{trader:foreign},{recipient:foreign},{chainId:42161},{symbol:"ETH/USD"},{builderFeeBps:1},{minimumBlock:undefined},{expectedData:"0x1"}])("rejects mismatched or unverified native execution metadata %j",async change=>{
    const h=harness(),prepared=h.prepared();
    expect(()=>validateOstiumExecution({...prepared,ostium:{...prepared.ostium,...change}as OstiumExecution},h.account)).toThrow();
  });
  it("keeps collateral removal owner-only and preserves immediate owner trading without compute",async()=>{
    const h=harness();
    await expect(h.platform.permission(h.user,{accountId:h.account.id,action:"prepare",allowedActions:["remove-collateral"]})).rejects.toMatchObject({code:"ACTION_NOT_AUTHORIZED"});
    const permission=await h.activate(),request=h.request({type:"remove-collateral",positionId:"native-position",mode:"agent"});
    expect(()=>validateOstiumExecution(h.prepared(request),h.account,permission)).toThrow(expect.objectContaining({code:"OWNER_SIGNATURE_REQUIRED"}));
    expect((await h.platform.prepare(h.user,{...request,mode:"manual"})).action.accountId).toBe(h.account.id);
    expect(h.engine.mock.calls.some(([name])=>name==="planWith0G")).toBe(false);
  });
  it("rechecks freshly rebuilt native collateral caps before any agent signature",async()=>{
    const h=harness();await h.activate({maxCollateralUsd:"10"});
    const review=await h.platform.prepare(h.user,h.request({mode:"agent"})),previous=h.engine.getMockImplementation()!;
    h.engine.mockImplementation(async(name,...args)=>{
      if(name==="submitAgentAction"){const action=args[0]as PreparedAction;(args[3]as{assertAuthority:(fresh:PreparedAction)=>void}).assertAuthority({...action,ostium:{...action.ostium!,collateralUsd:"11"}});throw new Error("Should not sign");}
      return previous(name,...args);
    });
    await expect(h.platform.submit(h.user,{actionId:review.action.id})).rejects.toMatchObject({code:"COLLATERAL_LIMIT"});
    expect(h.store.get<StoredAction>(h.user.id,"action",review.action.id)?.transactionHash).toBeUndefined();
  });
  it("allows owner entry and authorized agent exit against the same native account",async()=>{
    const h=harness();await h.activate();
    const opened=await h.platform.prepare(h.user,h.request());
    expect((await h.platform.submit(h.user,{actionId:opened.action.id,transactionHash:`0x${"c".repeat(64)}`})).action.status).toBe("confirmed");
    const exit=await h.platform.prepare(h.user,h.request({mode:"agent",type:"close",positionId:"native-position",amountUnit:"base",amount:"1"}));
    const closed=await h.platform.submit(h.user,{actionId:exit.action.id});
    expect(closed.action).toMatchObject({accountId:opened.action.accountId,status:"confirmed",transactionHash:tradeHash});
    expect(h.engine.mock.calls.filter(([name])=>name==="submitAgentAction")).toHaveLength(1);
    h.setDelegate(zero);
    await expect(h.platform.prepare(h.user,h.request({mode:"agent"}))).rejects.toMatchObject({code:"AGENT_NOT_APPROVED"});
    expect((await h.platform.prepare(h.user,h.request())).action.accountId).toBe(h.account.id);
  });
});

describe("Ostium owner approval and transaction recovery",()=>{
  it.each(["0","-1","2000000.000001","10.0000001","999999999999999999999999"])("rejects ambiguous or out-of-bounds exact allowance %s before provider reads",async amountUsd=>{
    const h=harness();await expect(prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd,requestId:"invalid"})).rejects.toThrow();expect(h.engine).not.toHaveBeenCalled();
  });
  it.each([undefined,"0","1.5"])("requires a positive observed block anchor before accepting a new allowance plan %s",async minimumBlock=>{
    const h=harness(),previous=h.engine.getMockImplementation()!;
    h.engine.mockImplementation(async(name,...args)=>{const result=await previous(name,...args);return name==="getOstiumApprovalTransaction"?{...result as Record<string,unknown>,minimumBlock}:result;});
    await expect(prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd:"10",requestId:"missing-block"})).rejects.toMatchObject({code:"ALLOWANCE_PLAN_INVALID"});
    expect(listOstiumAllowances(h.store,h.user).intents).toHaveLength(0);
  });
  it("persists exact allowance intent before the wallet, prevents duplicate popup claims and reconciles late receipts once",async()=>{
    const h=harness(true),input={accountId:h.account.id,amountUsd:"10",requestId:"exact-allowance"},first=await prepareOstiumAllowance(h.store,h.user,input);
    expect(first.intent).toMatchObject({amountRaw:"10000000",minimumBlock:"100",status:"prepared"});expect(first.intent.notBefore).toBeGreaterThan(1_000_000_000_000);
    expect((await prepareOstiumAllowance(h.store,h.user,input)).intent.id).toBe(first.intent.id);
    await expect(prepareOstiumAllowance(h.store,h.user,{...input,amountUsd:"11"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    submitOstiumAllowance(h.store,h.user,first.intent.id);
    expect(()=>submitOstiumAllowance(h.store,h.user,first.intent.id)).toThrow(expect.objectContaining({code:"ALLOWANCE_PENDING"}));
    expect(()=>cancelOstiumAllowance(h.store,h.user,first.intent.id)).toThrow();
    h.store.update<OstiumAllowanceIntent&{userId:string}>(h.user.id,"ostium-allowance",first.intent.id,{expiresAt:Date.now()-1});
    submitOstiumAllowance(h.store,h.user,first.intent.id,approvalHash);
    h.store.db.close();const restarted=new Store(h.path);stores.push(restarted);
    expect((await reconcileOstiumAllowance(restarted,h.user,first.intent.id)).intent.status).toBe("confirmed");
    const calls=h.engine.mock.calls.filter(([name])=>name==="reconcileOstiumApproval").length;
    expect((await reconcileOstiumAllowance(restarted,h.user,first.intent.id)).intent.status).toBe("confirmed");
    expect(h.engine.mock.calls.filter(([name])=>name==="reconcileOstiumApproval")).toHaveLength(calls);
    expect(listOstiumAllowances(restarted,h.user).intents[0]).not.toHaveProperty("userId");
  });
  it("allows definitive unsigned4001 rejection but holds unknown or already signed requests",async()=>{
    const h=harness(),first=await prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd:"10",requestId:"owner-rejected"});
    submitOstiumAllowance(h.store,h.user,first.intent.id);
    expect(cancelOstiumAllowance(h.store,h.user,first.intent.id,true).intent.status).toBe("rejected");
    const second=await prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd:"10",requestId:"signed"});
    submitOstiumAllowance(h.store,h.user,second.intent.id,approvalHash);
    expect(()=>cancelOstiumAllowance(h.store,h.user,second.intent.id,true)).toThrow(expect.objectContaining({code:"ALLOWANCE_PENDING"}));
    const another=h.store.ensureUser(foreign);await expect(reconcileOstiumAllowance(h.store,another,second.intent.id)).rejects.toMatchObject({code:"ALLOWANCE_NOT_FOUND"});
  });
  it("rejects expired unsigned starts, wrong native approval plans and replayed approval hashes",async()=>{
    const h=harness(),first=await prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd:"10",requestId:"expiry"});
    h.store.update<OstiumAllowanceIntent&{userId:string}>(h.user.id,"ostium-allowance",first.intent.id,{expiresAt:Date.now()-1});
    expect(()=>submitOstiumAllowance(h.store,h.user,first.intent.id)).toThrow(expect.objectContaining({code:"ALLOWANCE_EXPIRED"}));
    await reconcileOstiumAllowance(h.store,h.user,first.intent.id,approvalHash);
    const second=await prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd:"10",requestId:"replay"});
    await expect(reconcileOstiumAllowance(h.store,h.user,second.intent.id,approvalHash)).rejects.toMatchObject({code:"ALLOWANCE_PROOF_REPLAY"});
    h.store.update<OstiumAllowanceIntent&{userId:string}>(h.user.id,"ostium-allowance",second.intent.id,{status:"rejected"});
    h.engine.mockResolvedValue({trader:owner,chainId:421614,token,spender:contract,amountUsd:"10",amountRaw:"10000000",transaction:{to:token,data:"0x12345678",value:"0",chainId:421614},expiresAt:Date.now()+60_000});
    await expect(prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd:"10",requestId:"wrong-plan"})).rejects.toMatchObject({code:"ALLOWANCE_PLAN_INVALID"});
  });
  it("journals child approvals independently, holds unknown wallet results and recovers their hash after restart",async()=>{
    const h=harness(true);h.includeApproval();const review=await h.platform.prepare(h.user,h.request());
    await h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",approvalStarted:true,approvalIndex:0}});
    await expect(h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",approvalStarted:true,approvalIndex:0}})).rejects.toMatchObject({code:"ALLOWANCE_PENDING"});
    await h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",submissionUnknown:true,phase:"approval",approvalIndex:0}});
    await expect(h.platform.prepare(h.user,h.request())).rejects.toMatchObject({code:"ACCOUNT_RECONCILING"});
    await expect(h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",ownerRejected:true,phase:"approval",approvalIndex:0}})).rejects.toMatchObject({code:"ALLOWANCE_PENDING"});
    h.store.db.close();const store=new Store(h.path);stores.push(store);const platform=new Platform(store);
    const recovered=await platform.submit(h.user,{actionId:review.action.id,transactionHash:approvalHash,approvalIndex:0});
    expect(recovered.action.approvals?.[0]).toMatchObject({status:"confirmed",transactionHash:approvalHash});expect(recovered.action.transactionHash).toBeUndefined();expect(recovered.action.status).toBe("awaiting-approval");
    expect(h.engine.mock.calls.find(([name])=>name==="reconcileOstiumApproval")?.[1]).toMatchObject({minimumBlock:"100",notBefore:review.action.createdAt});
    await platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",tradeStarted:true}});
    await expect(platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",tradeStarted:true}})).rejects.toMatchObject({code:"ACCOUNT_RECONCILING"});
    const completed=await platform.submit(h.user,{actionId:review.action.id,transactionHash:tradeHash});expect(completed.action.status).toBe("confirmed");
    expect(h.engine.mock.calls.some(([name])=>name==="submitAgentAction")).toBe(false);
  });
  it("saves a submitted owner approval hash even if receipt verification becomes unavailable",async()=>{
    const h=harness();h.includeApproval();const review=await h.platform.prepare(h.user,h.request());h.engine.mockRejectedValue(new Error("Fixture provider offline"));
    await expect(h.platform.submit(h.user,{actionId:review.action.id,transactionHash:approvalHash,approvalIndex:0})).rejects.toThrow(/offline/);
    expect(h.store.get<StoredAction>(h.user.id,"action",review.action.id)).toMatchObject({approvals:[{index:0,status:"pending",transactionHash:approvalHash}]});
    expect(h.store.get<StoredAction>(h.user.id,"action",review.action.id)?.transactionHash).toBeUndefined();
  });
  it("distinguishes explicit unsigned child and trade rejection from unresolved submissions",async()=>{
    const h=harness();h.includeApproval();const review=await h.platform.prepare(h.user,h.request());
    await h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",approvalStarted:true,approvalIndex:0}});
    expect((await h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",ownerRejected:true,phase:"approval",approvalIndex:0}})).action.approvals?.[0].status).toBe("rejected");
    await h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",approvalStarted:true,approvalIndex:0}});
    await h.platform.submit(h.user,{actionId:review.action.id,transactionHash:approvalHash,approvalIndex:0});
    await h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",tradeStarted:true}});
    expect((await h.platform.submit(h.user,{actionId:review.action.id,result:{venue:"ostium",ownerRejected:true,phase:"trade"}})).action.status).toBe("rejected");
    const next=await h.platform.prepare(h.user,h.request());
    await h.platform.submit(h.user,{actionId:next.action.id,result:{venue:"ostium",submissionUnknown:true,phase:"trade"}});
    await expect(h.platform.submit(h.user,{actionId:next.action.id,result:{venue:"ostium",ownerRejected:true,phase:"trade"}})).rejects.toMatchObject({code:"ACCOUNT_RECONCILING"});
  });
  it("does not accept native acknowledgement as a fill or reuse a historical settled trade",async()=>{
    const h=harness(true),first=await h.platform.prepare(h.user,h.request());h.setNativeStatus("pending");
    expect((await h.platform.submit(h.user,{actionId:first.action.id,transactionHash:tradeHash})).action.status).toBe("pending");
    h.setNativeStatus("confirmed");expect((await h.platform.submit(h.user,{actionId:first.action.id,transactionHash:tradeHash})).action.status).toBe("confirmed");
    h.store.db.close();const store=new Store(h.path);stores.push(store);const platform=new Platform(store),second=await platform.prepare(h.user,h.request()),replayed=await platform.submit(h.user,{actionId:second.action.id,transactionHash:tradeHash});
    expect(replayed.action.status).not.toBe("confirmed");expect(replayed.action.error).toContain("already belongs");
  });
  it("exposes owner-scoped native history and exact allowances without another venue's data",async()=>{
    const h=harness();
    expect((await h.http(`accounts/${h.account.id}/history`)).body.data.venue).toBe("ostium");
    const prepared=await h.http("ostium/allowances/prepare",{accountId:h.account.id,amountUsd:"10",requestId:"http"});expect(prepared.status).toBe(201);
    expect((await h.http("ostium/allowances/submit",{intentId:prepared.body.data.intent.id})).body.data.intent.status).toBe("submitting");
    expect((await h.http("ostium/allowances/cancel",{intentId:prepared.body.data.intent.id,ownerRejected:true})).body.data.intent.status).toBe("rejected");
    expect((await h.http("orderbook?venue=ostium&symbol=XAU%2FUSD")).body.error.code).toBe("ORDER_BOOK_UNAVAILABLE");
    expect((await h.http("automations",{accountId:h.account.id,name:"Native conditional",intervalSeconds:300,request:h.request()})).body.error.code).toBe("AGENT_NOT_AUTHORIZED");
    expect(h.engine.mock.calls.some(([name])=>name==="planWith0G"||name==="submitAgentAction")).toBe(false);
  });
  it("only releases a pre-send allowance claim with its private attempt token",async()=>{
    const h=harness(),submissionToken=crypto.randomUUID(),otherToken=crypto.randomUUID();
    const prepared=await h.http("ostium/allowances/prepare",{accountId:h.account.id,amountUsd:"100",requestId:"preflight"}),intentId=prepared.body.data.intent.id;
    const claimed=await h.http("ostium/allowances/submit",{intentId,submissionToken});
    expect(claimed.body.data.intent.status).toBe("submitting");
    expect(JSON.stringify(claimed.body)).not.toContain(submissionToken);
    expect(claimed.body.data.intent.submissionTokenHash).toBeUndefined();
    expect((await h.http("ostium/allowances/cancel",{intentId,preflightFailed:true})).status).toBe(400);
    expect((await h.http("ostium/allowances/cancel",{intentId,preflightFailed:true,submissionToken:otherToken})).body.error.code).toBe("ALLOWANCE_CLAIM_MISMATCH");
    expect((await h.http("ostium/allowances/cancel",{intentId,ownerRejected:true})).body.error.code).toBe("ALLOWANCE_CLAIM_MISMATCH");
    expect((await h.http("ostium/allowances/cancel",{intentId,ownerRejected:true,submissionToken:otherToken})).body.error.code).toBe("ALLOWANCE_CLAIM_MISMATCH");
    expect((await h.http("ostium/allowances/submit",{intentId,submissionToken:otherToken})).body.error.code).toBe("ALLOWANCE_PENDING");
    expect((await h.http("ostium/allowances/cancel",{intentId,preflightFailed:true,submissionToken})).body.data.intent).toMatchObject({status:"rejected",error:"Wallet checks failed before a transaction was requested."});
  });
  it("does not use a preflight token to clear old unknown or hash-bearing approvals",async()=>{
    const h=harness(),submissionToken=crypto.randomUUID();
    const old=await prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd:"100",requestId:"old"});
    submitOstiumAllowance(h.store,h.user,old.intent.id);
    expect(()=>cancelOstiumAllowance(h.store,h.user,old.intent.id,false,true,submissionToken)).toThrow(expect.objectContaining({code:"ALLOWANCE_CLAIM_MISMATCH"}));
    cancelOstiumAllowance(h.store,h.user,old.intent.id,true);
    const next=await prepareOstiumAllowance(h.store,h.user,{accountId:h.account.id,amountUsd:"100",requestId:"next"});
    submitOstiumAllowance(h.store,h.user,next.intent.id,undefined,submissionToken);
    submitOstiumAllowance(h.store,h.user,next.intent.id,approvalHash);
    expect(()=>cancelOstiumAllowance(h.store,h.user,next.intent.id,false,true,submissionToken)).toThrow(expect.objectContaining({code:"ALLOWANCE_PENDING"}));
  });
  it("runs native alerts through their own CRE binding and keeps unattended removal owner-only",async()=>{
    const h=harness(),condition={symbol:"XAU/USD",operator:"above",price:"4000"};
    const alert=h.platform.createAutomation(h.user,{kind:"alert",accountId:h.account.id,name:"Gold watch",condition});
    h.engine.mockImplementation(async(name,...args)=>{
      expect(name).toBe("evaluateStrategy");
      const input=args[0]as{evaluationId:string;automationId:string;account:typeof h.account;expiresAt:number;controlRevision:number;policyVersion:number};
      expect(input.account).toMatchObject({venue:"ostium",chainId:421614});
      return{id:input.evaluationId,automationId:input.automationId,accountId:input.account.id,chainId:421614,controlRevision:input.controlRevision,policyVersion:input.policyVersion,expiresAt:input.expiresAt,source:"local-simulation",observedAt:Date.now(),decision:"no-action",reason:"The native condition was not met"};
    });
    expect((await h.platform.tick()).results).toContainEqual(expect.objectContaining({automationId:alert.id,kind:"alert",decision:"no-action"}));
    expect(h.store.list(h.user.id,"action")).toHaveLength(0);
    expect(h.engine).toHaveBeenCalledOnce();
    expect(()=>h.platform.createAutomation(h.user,{accountId:h.account.id,name:"Forbidden removal",intervalSeconds:300,request:h.request({type:"remove-collateral",positionId:"native-position"})})).toThrow(expect.objectContaining({code:"OWNER_SIGNATURE_REQUIRED"}));
    expect(()=>h.platform.createAutomation(h.user,{accountId:h.account.id,name:"Wrong market",request:h.request(),condition:{...condition,symbol:"USD/JPY"}})).toThrow("same market");
  });
});
