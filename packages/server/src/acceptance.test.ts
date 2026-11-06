import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { tradeRequestSchema,type PreparedAction,type TradeRequest } from "@orcus/core";
import { handleRequest } from "./http";
import { Platform } from "./platform";
import { Store } from "./store";
import type { StoredAction,StoredPermission } from "./types";
import * as boundary from "./engine";

const origin="http://localhost:3000";
let directory:string;
beforeAll(()=>{directory=mkdtempSync(join(tmpdir(),"orcus-acceptance-"));vi.stubEnv("ORCUS_DATA_DIR",directory);vi.stubEnv("ORCUS_APP_URL",origin);});
afterAll(()=>{vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true});});

async function harness(){
  const store=new Store(":memory:"),owner=privateKeyToAccount(generatePrivateKey());let cookie="";
  const request=async(path:string,method="GET",body?:unknown,headers:Record<string,string>={})=>{
    const response=await handleRequest(new Request(`${origin}/api/${path}`,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{"Content-Type":"application/json"}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),store);
    return{status:response.status,result:await response.json(),cookie:response.headers.get("set-cookie")};
  };
  const challenge=await request("auth/challenge","POST",{address:owner.address});
  const signature=await owner.signMessage({message:challenge.result.data.message});
  const login=await request("auth/verify","POST",{challengeId:challenge.result.data.id,signature});cookie=login.cookie!.split(";")[0];
  const connected=await request("accounts","POST",{venue:"hyperliquid"}),account=connected.result.data;
  let position="0",nextOrder=100;
  const engine=vi.spyOn(boundary,"callEngine").mockImplementation(async(name,...args)=>{
    if(name==="getComputeBalance")return{status:"unconfigured",message:"Fixture provider balance"};
    if(name==="getMarkets")return[{venue:"hyperliquid",symbol:"ETH",baseAsset:"ETH",quoteAsset:"USDC",midPrice:"2000",observedAt:Date.now()}];
    if(name==="getPortfolio")return{accountId:account.id,balances:[{accountId:account.id,symbol:"USDC",amount:"10000"}],positions:position==="0"?[]:[{id:"existing",accountId:account.id,venue:"hyperliquid",symbol:"ETH",side:"long",size:position,entryPrice:"2000",unrealizedPnl:"0",observedAt:Date.now()}],orders:[],observedAt:Date.now()};
    if(name==="prepareAction"){
      const input=tradeRequestSchema.parse(args[0]);
      const action:TradeRequest=["close","reduce"].includes(input.type)?{...input,side:"sell",amount:input.type==="close"?position:input.amount,reduceOnly:true}:input;
      return{id:"venue-fixture",request:action,account:args[1],kind:"hyperliquid",expiresAt:Date.now()+60_000,controlRevision:account.controlRevision,hyperliquid:{method:"order",params:{orders:[{c:`0x${"1".repeat(32)}`} ]}}}as PreparedAction;
    }
    if(name==="planWith0G"){
      const instruction=String(args[0]);
      return{message:"Fixture proposal for the shared account",proposal:tradeRequestSchema.parse({accountId:account.id,venue:"hyperliquid",type:instruction.includes("close")?"close":"market",symbol:"ETH",side:instruction.includes("close")?"sell":"buy",amount:"1",mode:"agent"}),requestId:`provider-fixture-${instruction.includes("close")?"close":"open"}`,costUsd:"0"};
    }
    if(name==="submitAgentAction"){
      const prepared=args[0]as PreparedAction,options=args[3]as{assertAuthority?:()=>void};options.assertAuthority?.();position=prepared.request.reduceOnly?"0":prepared.request.amount;return{status:"pending",orderId:String(++nextOrder)};
    }
    if(name==="reconcileAction")return{status:"confirmed",orderId:String((args[0]as StoredAction).orderId??++nextOrder),evidence:{fixture:true}};
    throw new Error(`Unexpected fixture engine call ${name}`);
  });
  const nativeApproval=vi.spyOn(Platform.prototype,"verifyHyperliquidApproval").mockResolvedValue();
  return{store,request,account,engine,setPosition:(value:string)=>{position=value;},close:()=>{engine.mockRestore();nativeApproval.mockRestore();store.db.close();}};
}

describe("shared-account server acceptance with explicit venue fixtures",()=>{
  it("supports owner-open, agent-close, takeover and agent-open, owner-close on one account",async()=>{
    const h=await harness();
    try{
      await h.request("budget","POST",{limitUsd:"1"});
      const grant=await h.request("permissions","POST",{accountId:h.account.id,action:"prepare",allowedSymbols:["ETH"],maxTradeUsd:"5000"});
      expect((await h.request("permissions","POST",{accountId:h.account.id,action:"activate",permissionId:grant.result.data.permission.id})).status).toBe(200);
      const ownerRequest={accountId:h.account.id,venue:"hyperliquid",type:"market",symbol:"ETH",side:"buy",amount:"1",mode:"manual"};
      const opened=await h.request("actions/prepare","POST",ownerRequest);h.setPosition("1");
      expect((await h.request("actions/submit","POST",{actionId:opened.result.data.action.id,orderId:"100",response:{fixture:true}})).result.data.action.status).toBe("confirmed");
      await h.request("agent/control","POST",{command:"update",mode:"autonomous"});
      const closed=await h.request("agent/chat","POST",{message:"Please close my ETH position",accountId:h.account.id,autonomous:true,requestId:"close-manual-position"});
      expect(closed.status).toBe(200);expect(closed.result.data.action.accountId).toBe(h.account.id);expect(closed.result.data.action.prepared.request.reduceOnly).toBe(true);
      expect(closed.result.data.action.audit).toMatchObject({instruction:"Please close my ETH position",providerRequestId:"provider-fixture-close",permission:{decision:"allowed",permissionId:grant.result.data.permission.id}});
      expect((await h.request("portfolio")).result.data.positions).toHaveLength(0);
      await h.request("agent/control","POST",{command:"take-over"});
      expect((await h.request("actions/prepare","POST",ownerRequest)).status).toBe(200);
      await h.request("agent/control","POST",{command:"resume"});
      const agentOpened=await h.request("agent/chat","POST",{message:"Open an ETH position",accountId:h.account.id,autonomous:true,requestId:"agent-open"});
      expect(agentOpened.result.data.action.status).toBe("confirmed");expect((await h.request("portfolio")).result.data.positions[0].accountId).toBe(h.account.id);
      const ownerClose=await h.request("actions/prepare","POST",{...ownerRequest,type:"close",side:"sell"});h.setPosition("0");
      expect((await h.request("actions/submit","POST",{actionId:ownerClose.result.data.action.id,orderId:"105",response:{fixture:true}})).result.data.action.status).toBe("confirmed");
      expect((await h.request("portfolio")).result.data.positions).toHaveLength(0);
      await h.request("permissions","POST",{accountId:h.account.id,action:"revoke"});
      expect((await h.request("actions/prepare","POST",{...ownerRequest,mode:"agent"})).status).toBe(403);
      expect((await h.request("actions/prepare","POST",ownerRequest)).status).toBe(200);
    }finally{h.close();}
  });
  it("binds owner-reviewed proposals to the original instruction and rejects changed orders",async()=>{
    const h=await harness();
    try{
      await h.request("budget","POST",{limitUsd:"1"});
      const chat=await h.request("agent/chat","POST",{message:"Open an ETH position",accountId:h.account.id,requestId:"reviewed"}),message=chat.result.data.message;
      const reviewed={...message.proposedAction,mode:"manual"},headers={"X-Orcus-Message-Id":message.id};
      const prepared=await h.request("actions/prepare","POST",reviewed,headers);
      expect(prepared.result.data.action.audit).toMatchObject({sourceMessageId:message.id,instruction:"Open an ETH position",providerRequestId:"provider-fixture-open",permission:{decision:"owner-signature-required"}});
      expect((await h.request("actions/prepare","POST",{...reviewed,amount:"2"},headers)).status).toBe(409);
    }finally{h.close();}
  });
  it("shows expired permissions and makes activation retries idempotent",async()=>{
    const h=await harness();
    try{
      const first=await h.request("permissions","POST",{accountId:h.account.id,action:"prepare",maxTradeUsd:"5000"}),second=await h.request("permissions","POST",{accountId:h.account.id,action:"prepare",maxTradeUsd:"2500"});
      const permissions=(await h.request("permissions")).result.data.permissions;
      expect(permissions.find((item:StoredPermission)=>item.id===first.result.data.permission.id)).toMatchObject({status:"revoked",supersededBy:second.result.data.permission.id});
      const activation={accountId:h.account.id,action:"activate",permissionId:second.result.data.permission.id};
      expect((await h.request("permissions","POST",activation)).status).toBe(200);expect((await h.request("permissions","POST",activation)).status).toBe(200);
      const user=h.store.getUser(h.account.ownerAddress)!;h.store.update<StoredPermission>(user.id,"permission",second.result.data.permission.id,{expiresAt:Date.now()-1});
      expect((await h.request("permissions")).result.data.permissions.find((item:StoredPermission)=>item.id===second.result.data.permission.id).status).toBe("expired");
      expect((await h.request("session")).result.data.accounts[0].status).toBe("connected");
      expect((await h.request("actions/prepare","POST",{accountId:h.account.id,venue:"hyperliquid",type:"market",symbol:"ETH",side:"buy",amount:"1",mode:"agent"})).status).toBe(403);
    }finally{h.close();}
  });
});
