import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tradeRequestSchema, type PreparedAction } from "@orcus/core";
import { ApiError } from "./errors";
import { Platform } from "./platform";
import { Store } from "./store";
import { setBudget } from "./budget";
import * as engineBoundary from "./engine";
import type { StoredAccount, StoredAction, StoredAutomation, StoredPermission } from "./types";

let runtimeDirectory:string;
beforeAll(()=>{runtimeDirectory=mkdtempSync(join(tmpdir(),"orcus-worker-"));vi.stubEnv("ORCUS_DATA_DIR",runtimeDirectory);});
afterAll(()=>{vi.unstubAllEnvs();rmSync(runtimeDirectory,{recursive:true,force:true});});

function setup(){
  const store=new Store(":memory:"),user=store.ensureUser("0x1111111111111111111111111111111111111111"),platform=new Platform(store),account=platform.createAccount(user,{venue:"hyperliquid"});
  return{store,user,platform,account};
}
function evaluated(input:Record<string,unknown>){
  const account=input.account as{id:string;chainId:number};
  return{id:input.evaluationId,automationId:input.automationId,accountId:account.id,chainId:account.chainId,controlRevision:input.controlRevision,policyVersion:input.policyVersion,expiresAt:input.expiresAt,requestId:input.requestId,source:"local-simulation",observedAt:Date.now(),decision:"no-action",reason:"The approved condition was evaluated"};
}

describe("durable worker coordination",()=>{
  it("refuses pasted credentials before storing chat history or calling the engine",async()=>{
    const{store,user,platform}=setup(),engine=vi.spyOn(engineBoundary,"callEngine");
    try{
      await expect(platform.chat(user,{message:`Use mk-${"generated".repeat(4)}`,requestId:"secret-input"})).rejects.toMatchObject({code:"CREDENTIAL_INPUT_REJECTED"});
      expect(store.list(user.id,"message")).toHaveLength(0);
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM expenses").get()).toEqual({count:0});
      expect(engine).not.toHaveBeenCalled();
    }finally{engine.mockRestore();store.db.close();}
  });
  it("persists the active evaluation before calling CRE and serializes overlapping ticks",async()=>{
    const{store,user,platform,account}=setup(),engine=vi.spyOn(engineBoundary,"callEngine");
    let release:()=>void=()=>{};
    const gate=new Promise<void>(resolve=>{release=resolve;});
    try{
      const job=platform.createAutomation(user,{kind:"alert",accountId:account.id,name:"ETH watch",condition:{symbol:"ETH",operator:"above",price:"2000"}});
      engine.mockImplementation(async(name,...args)=>{
        expect(name).toBe("evaluateStrategy");
        const input=args[0]as Record<string,unknown>,running=store.get<StoredAutomation>(user.id,"automation",job.id)!;
        expect(running.runningEvaluationId).toBe(input.evaluationId);
        expect(store.get(user.id,"evaluation-run",String(input.evaluationId))).toMatchObject({status:"running"});
        await gate;
        return evaluated(input);
      });
      const first=platform.tick();
      await vi.waitFor(()=>expect(engine).toHaveBeenCalledOnce());
      expect(await platform.tick()).toMatchObject({busy:true,processed:0});
      release();await first;
      expect(store.get<StoredAutomation>(user.id,"automation",job.id)?.runningEvaluationId).toBeUndefined();
      expect(store.list(user.id,"evaluation-run")).toEqual([expect.objectContaining({status:"completed"})]);
    }finally{release();engine.mockRestore();store.db.close();}
  });

  it("rejects a returning alert result after account authority changed",async()=>{
    const{store,user,platform,account}=setup(),engine=vi.spyOn(engineBoundary,"callEngine");
    try{
      const job=platform.createAutomation(user,{kind:"alert",accountId:account.id,name:"ETH watch",condition:{symbol:"ETH",operator:"above",price:"2000"}});
      engine.mockImplementation(async(_name,...args)=>{
        store.update<StoredAccount>(user.id,"account",account.id,{controlRevision:account.controlRevision+1});
        return{...evaluated(args[0]as Record<string,unknown>),decision:"allow"};
      });
      await platform.tick();
      expect(platform.notifications(user).notifications).toHaveLength(0);
      expect(store.get<StoredAutomation>(user.id,"automation",job.id)).toMatchObject({status:"failed"});
      expect(store.list(user.id,"evaluation")).toHaveLength(0);
    }finally{engine.mockRestore();store.db.close();}
  });

  it("fails an interrupted evaluation closed instead of replaying its trade",async()=>{
    const{store,user,platform,account}=setup(),engine=vi.spyOn(engineBoundary,"callEngine");
    try{
      const job=platform.createAutomation(user,{kind:"alert",accountId:account.id,name:"ETH watch",condition:{symbol:"ETH",operator:"above",price:"2000"}});
      store.update<StoredAutomation>(user.id,"automation",job.id,{runningEvaluationId:"interrupted",runningStartedAt:Date.now()-1000});
      const result=await platform.tick();
      expect(result.results).toContainEqual(expect.objectContaining({status:"interrupted"}));
      expect(store.get<StoredAutomation>(user.id,"automation",job.id)).toMatchObject({status:"failed"});
      expect(store.get(user.id,"evaluation-run","interrupted")).toMatchObject({status:"interrupted"});
      expect(engine).not.toHaveBeenCalled();
    }finally{engine.mockRestore();store.db.close();}
  });

  it("reconciles submitted actions without a browser or due job",async()=>{
    const{store,user,platform,account}=setup(),engine=vi.spyOn(engineBoundary,"callEngine");
    try{
      const request=tradeRequestSchema.parse({accountId:account.id,venue:"hyperliquid",type:"market",symbol:"ETH",side:"buy",amount:"1"}),prepared:PreparedAction={id:"pending",request,account,kind:"hyperliquid",expiresAt:Date.now()+60_000,controlRevision:0};
      store.put("action",{id:"pending",userId:user.id,accountId:account.id,request,prepared,status:"submitted-unknown",initiator:"agent",controlRevision:0,agentRevision:0,expiresAt:prepared.expiresAt,createdAt:Date.now(),updatedAt:Date.now()}satisfies StoredAction);
      engine.mockImplementation(async name=>{expect(name).toBe("reconcileAction");return{status:"confirmed",orderId:"123"};});
      expect(await platform.tick()).toMatchObject({reconciled:1});
      expect(store.get<StoredAction>(user.id,"action","pending")).toMatchObject({status:"confirmed",orderId:"123"});
    }finally{engine.mockRestore();store.db.close();}
  });

  it("orders due jobs by the oldest due time rather than creation order",()=>{
    const{store,user,platform,account}=setup();
    try{
      const input={kind:"alert",accountId:account.id,name:"ETH watch",condition:{symbol:"ETH",operator:"above",price:"2000"}};
      const newer=platform.createAutomation(user,input),older=platform.createAutomation(user,input);
      store.update<StoredAutomation>(user.id,"automation",newer.id,{nextRunAt:Date.now()-1000});
      store.update<StoredAutomation>(user.id,"automation",older.id,{nextRunAt:Date.now()-10_000});
      expect(store.dueAutomations<StoredAutomation>(1)[0].id).toBe(older.id);
    }finally{store.db.close();}
  });

  it("bounds transient retries and never retries unknown billable inference",async()=>{
    const{store,user,platform,account}=setup(),engine=vi.spyOn(engineBoundary,"callEngine");
    try{
      const job=platform.createAutomation(user,{kind:"alert",accountId:account.id,name:"ETH watch",condition:{symbol:"ETH",operator:"above",price:"2000"}});
      engine.mockRejectedValue(new ApiError("AGENT_BUSY","Another run is active",409));
      for(let attempt=1;attempt<=6;attempt++){
        store.update<StoredAutomation>(user.id,"automation",job.id,{nextRunAt:Date.now()-attempt});
        await platform.tick();
        expect(store.get<StoredAutomation>(user.id,"automation",job.id)?.status).toBe(attempt<=5?"active":"failed");
      }
      const unknown=platform.createAutomation(user,{kind:"alert",accountId:account.id,name:"Unknown result",condition:{symbol:"ETH",operator:"above",price:"2000"}});
      engine.mockRejectedValue(new ApiError("EVALUATION_PENDING","Provider usage is unknown",409));
      await platform.tick();
      expect(store.get<StoredAutomation>(user.id,"automation",unknown.id)?.status).toBe("failed");
    }finally{engine.mockRestore();store.db.close();}
  });

  it("uses the restricted strategy profile and refuses cached interactive proposals",async()=>{
    const{store,user,platform,account}=setup(),engine=vi.spyOn(engineBoundary,"callEngine");
    try{
      const now=Date.now();
      store.put("permission",{id:"grant",userId:user.id,accountId:account.id,agentAddress:account.agentAddress!,allowedSymbols:["ETH"],allowedActions:["market"],maxTradeUsd:"100",expiresAt:now+60_000,status:"active",enforcement:"application",controlRevision:0,createdAt:now,updatedAt:now}satisfies StoredPermission);
      setBudget(store,user.id,"1","0.1",false);
      platform.createAutomation(user,{accountId:account.id,name:"Bounded plan",instruction:"Review ETH conditions"});
      engine.mockImplementation(async(name,...args)=>{
        if(name==="getPortfolio")return{balances:[],positions:[],orders:[],observedAt:Date.now()};
        if(name==="planWith0G"){expect(args[1]).toMatchObject({toolProfile:"strategy"});return{message:"No action needed",costUsd:"0"};}
        throw new Error("No CRE call is needed when the planner proposes no trade");
      });
      await platform.tick();
      expect(engine).toHaveBeenCalledWith("planWith0G",expect.any(String),expect.objectContaining({toolProfile:"strategy"}));
      store.put("proposal",{id:"interactive-cache",userId:user.id,result:{message:"Interactive"},createdAt:now,updatedAt:now});
      await expect(platform.proposal(user,"Unattended",account,"interactive-cache","strategy")).rejects.toMatchObject({code:"TOOL_PROFILE_MISMATCH"});
    }finally{engine.mockRestore();store.db.close();}
  });
});
