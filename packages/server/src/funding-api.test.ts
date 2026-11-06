import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { handleRequest } from "./http";
import { Platform } from "./platform";
import { Store } from "./store";
import { ApiError } from "./errors";
import * as boundary from "./engine";

const origin="http://localhost:3000",beneficiary="0x3333333333333333333333333333333333333333",hash=`0x${"1".repeat(64)}`;
let directory:string;
beforeAll(()=>{directory=mkdtempSync(join(tmpdir(),"orcus-funding-api-"));vi.stubEnv("ORCUS_DATA_DIR",directory);vi.stubEnv("ORCUS_APP_URL",origin);});
afterAll(()=>{vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true});});

async function harness(){
  const filename=join(directory,`${Date.now()}-${Math.random()}.sqlite`),owner=privateKeyToAccount(generatePrivateKey());
  let store=new Store(filename),cookie="",verified=true,submission:"confirmed"|"submitted-unknown"="confirmed",settled=false;
  const request=async(path:string,body?:unknown)=>{
    const response=await handleRequest(new Request(`${origin}/api/${path}`,{method:body?"POST":"GET",headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})}),store);
    return{status:response.status,result:await response.json(),cookie:response.headers.get("set-cookie")};
  };
  const challenge=await request("auth/challenge",{address:owner.address}),signature=await owner.signMessage({message:challenge.result.data.message});
  const login=await request("auth/verify",{challengeId:challenge.result.data.id,signature});cookie=login.cookie!.split(";")[0];
  const evidence=(intent:{amountWei:string})=>({status:"confirmed",transactionHash:hash,amountWei:intent.amountWei,gasPaidWei:"100",beneficiary,chainId:16602,creditStatus:"awaiting-router-sync"});
  const engine=vi.spyOn(boundary,"callEngine").mockImplementation(async(name,...args)=>{
    if(name==="getComputeBalance")return verified?{status:"verified",source:"0g-router",currency:"0g",chainId:16602,accountAddress:beneficiary,balanceNeurons:"0",observedAt:Date.now(),message:"Explicit native balance fixture"}:{status:"unavailable",message:"Beneficiary account is not verified"};
    if(name==="readComputeVaultBalance")return{source:"payment-vault",chainId:16602,currency:"0g",accountAddress:beneficiary,balanceNeurons:"0",observedAt:Date.now()};
    if(name==="submitComputeFunding"){
      const intent=args[0]as{amountWei:string;payerAddress:string},key=args[1]as`0x${string}`,options=args[2]as{assertAuthority:()=>void;onSubmissionIntent:(hash:string)=>void};
      expect(privateKeyToAccount(key).address.toLowerCase()).toBe(intent.payerAddress.toLowerCase());expect(intent.payerAddress.toLowerCase()).not.toBe(owner.address.toLowerCase());
      options.assertAuthority();options.onSubmissionIntent(hash);options.assertAuthority();
      return submission==="confirmed"?evidence(intent):{status:"submitted-unknown",transactionHash:hash,chainId:16602,creditStatus:"unconfirmed"};
    }
    if(name==="reconcileComputeFunding")return settled?evidence(args[0]as{amountWei:string}):{status:"submitted-unknown",transactionHash:hash,chainId:16602,creditStatus:"unconfirmed"};
    throw new Error(`Unexpected funding fixture engine call ${name}`);
  });
  const policy={enabled:true,chainId:16602,currency:"0g",computeAccountAddress:beneficiary,topUp0G:"0.01",maximumTotal0G:"0.1",lowBalance0G:"0",maxGas0G:"0.001",expiresAt:Date.now()+3_600_000};
  return{request,engine,policy,owner,store:()=>store,verified:(value:boolean)=>{verified=value;},submission:(value:typeof submission)=>{submission=value;},settled:()=>{settled=true;},reopen:()=>{store.db.close();store=new Store(filename);},close:()=>{engine.mockRestore();store.db.close();}};
}

describe("owner-authorized compute funding API with explicit payment fixtures",()=>{
  it("rejects an unverified beneficiary and permits offline revocation without client authority metadata",async()=>{
    const h=await harness();
    try{
      h.verified(false);
      expect((await h.request("budget/funding/policy",h.policy)).result.error.code).toBe("COMPUTE_ACCOUNT_UNVERIFIED");
      h.engine.mockClear();
      expect((await h.request("budget/funding/policy",{enabled:false})).status).toBe(200);expect(h.engine).not.toHaveBeenCalled();
      expect((await h.request("budget/funding/cancel",{intentId:"unknown",phase:"not-submitted"})).status).toBe(400);
    }finally{h.close();}
  });
  it("binds deposits to the operating payer, exact policy and idempotent receipt settlement",async()=>{
    const h=await harness();
    try{
      expect((await h.request("budget/funding/policy",h.policy)).status).toBe(200);
      const prepared=await h.request("budget/funding/prepare",{requestId:"one-deposit"}),intentId=prepared.result.data.intent.id;
      expect((await h.request("budget/funding/prepare",{requestId:"one-deposit"})).result.data.intent.id).toBe(intentId);
      expect((await h.request("budget/funding/submit",{intentId})).result.data).toMatchObject({status:"confirmed",evidence:{creditStatus:"awaiting-router-sync"}});
      expect((await h.request("budget/funding/submit",{intentId})).result.data.status).toBe("confirmed");
      expect(h.engine.mock.calls.filter(call=>call[0]==="submitComputeFunding")).toHaveLength(1);
      const state=(await h.request("budget/funding")).result.data;expect(state.spent0G).toBe("0.0100000000000001");expect(state.reserved0G).toBe("0");
      expect((await h.request("budget")).result.data.replenishmentStatus).toBe("confirmed");
    }finally{h.close();}
  });
  it("holds uncertain transfers, never rebroadcasts, and reconciles even after owner revocation",async()=>{
    const h=await harness();
    try{
      h.submission("submitted-unknown");await h.request("budget/funding/policy",h.policy);
      const prepared=await h.request("budget/funding/prepare",{requestId:"uncertain"}),intentId=prepared.result.data.intent.id;
      expect((await h.request("budget/funding/submit",{intentId})).result.data.status).toBe("submitted-unknown");
      expect((await h.request("budget/funding/cancel",{intentId})).status).toBe(409);
      await h.request("budget/funding/submit",{intentId});expect(h.engine.mock.calls.filter(call=>call[0]==="submitComputeFunding")).toHaveLength(1);
      expect((await h.request("budget/funding")).result.data.reserved0G).toBe("0.011");
      await h.request("budget/funding/policy",{enabled:false});h.settled();
      expect((await h.request("budget/funding/reconcile",{intentId})).result.data.status).toBe("confirmed");
    }finally{h.close();}
  });
  it("recovers a prepared operating deposit from persisted state with no browser",async()=>{
    const h=await harness();
    try{
      await h.request("budget/funding/policy",h.policy);
      const prepared=await h.request("budget/funding/prepare",{requestId:"worker-restart"});h.reopen();
      const result=await new Platform(h.store()).tick();
      expect(result.results).toContainEqual({kind:"compute-funding",intentId:prepared.result.data.intent.id,status:"confirmed"});
      expect(h.engine.mock.calls.filter(call=>call[0]==="submitComputeFunding")).toHaveLength(1);
    }finally{h.close();}
  });
  it("releases a trusted not-submitted hash after takeover but rejects submitting it again",async()=>{
    const h=await harness();
    try{
      await h.request("budget/funding/policy",h.policy);
      const prepared=await h.request("budget/funding/prepare",{requestId:"pause-before-broadcast"}),intentId=prepared.result.data.intent.id;
      h.engine.mockImplementation(async(name,...args)=>{
        if(name!=="submitComputeFunding")throw new Error(`Unexpected engine call ${name}`);
        (args[2]as{onSubmissionIntent:(hash:string)=>void}).onSubmissionIntent(hash);
        new Platform(h.store()).control(h.store().getUser(h.owner.address)!,{command:"take-over"});
        throw Object.assign(new ApiError("FUNDING_CONTROL_CHANGED","Paused before broadcast",409),{phase:"not-submitted",evidence:{transactionHash:hash}});
      });
      expect((await h.request("budget/funding/submit",{intentId})).status).toBe(409);
      const state=(await h.request("budget/funding")).result.data;expect(state.reserved0G).toBe("0");expect(state.intents[0].status).toBe("cancelled");
      expect((await h.request("budget/funding/submit",{intentId})).result.data.status).toBe("cancelled");
    }finally{h.close();}
  });
});
