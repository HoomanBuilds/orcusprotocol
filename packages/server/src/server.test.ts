import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getBudget, reserveBudget, setBudget, settleReservation } from "./budget";
import { handleRequest, readBody } from "./http";
import { Store } from "./store";
import { Platform } from "./platform";
import * as engineBoundary from "./engine";

const origin = "http://localhost:3000";
let runtimeDirectory: string;
beforeAll(() => { runtimeDirectory = mkdtempSync(join(tmpdir(), "orcus-server-")); vi.stubEnv("ORCUS_DATA_DIR", runtimeDirectory); vi.stubEnv("ORCUS_APP_URL", origin); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(runtimeDirectory, { recursive: true, force: true }); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("owner authentication", () => {
  it("requires an owner signature, consumes the nonce once and isolates private routes", async () => {
    const store = new Store(":memory:");
    try {
      const owner = privateKeyToAccount(generatePrivateKey());
      const challengeResponse = await handleRequest(post("auth/challenge", { address: owner.address }), store);
      expect(challengeResponse.status).toBe(200);
      const { data: challenge } = await challengeResponse.json() as { data: { id: string; message: string } };
      const signature = await owner.signMessage({ message: challenge.message });
      const login = await handleRequest(post("auth/verify", { challengeId: challenge.id, signature }), store);
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).toContain("HttpOnly");
      expect(login.headers.get("set-cookie")).toContain("SameSite=Lax");
      const token = login.headers.get("set-cookie")!.split(";")[0];
      const session = await handleRequest(new Request(`${origin}/api/session`, { headers: { Cookie: token } }), store);
      expect((await session.json()).data.user.address).toBe(owner.address.toLowerCase());
      const replay = await handleRequest(post("auth/verify", { challengeId: challenge.id, signature }), store);
      expect(replay.status).toBe(401);
      const privateRead = await handleRequest(new Request(`${origin}/api/activity`), store);
      expect(privateRead.status).toBe(401);
    } finally { store.db.close(); }
  });
  it("rejects cross-site account changes before creating an account", async () => {
    const store = new Store(":memory:");
    try {
      const response = await handleRequest(post("auth/challenge", { address: "0x1111111111111111111111111111111111111111" }, { Origin: "https://other.invalid" }), store);
      expect(response.status).toBe(403);
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM challenges").get()).toEqual({ count: 0 });
    } finally { store.db.close(); }
  });
  it("does not return operator RPC credentials in wallet configuration", async () => {
    vi.stubEnv("SEPOLIA_RPC_URL", "https://rpc.invalid/operator-secret");
    const response = await handleRequest(new Request(`${origin}/api/wallet-config`));
    const result = await response.text();
    expect(result).toContain('"rpcUrl":"/api/rpc"');
    expect(result).not.toContain("operator-secret");
  });
});

describe("durable limits", () => {
  it("runs read-only alerts without delegation and deduplicates repeated trigger conditions",async()=>{
    const store=new Store(":memory:"),engine=vi.spyOn(engineBoundary,"callEngine");
    try{
      const user=store.ensureUser("0x1111111111111111111111111111111111111111"),platform=new Platform(store),account=platform.createAccount(user,{venue:"hyperliquid"});
      const job=platform.createAutomation(user,{kind:"alert",accountId:account.id,name:"ETH price",intervalSeconds:60,condition:{symbol:"ETH",operator:"above",price:"2000"}});
      expect(store.list(user.id,"permission")).toHaveLength(0);
      let decision:"allow"|"no-action"="allow";
      engine.mockImplementation(async(name,...args)=>{
        if(name!=="evaluateStrategy")throw new Error("A read-only alert must not plan or submit a trade");
        const input=args[0]as{evaluationId:string;automationId:string;account:{id:string;chainId:number};controlRevision:number;policyVersion:number;expiresAt:number};
        return{id:input.evaluationId,automationId:input.automationId,accountId:input.account.id,chainId:input.account.chainId,controlRevision:input.controlRevision,policyVersion:input.policyVersion,expiresAt:input.expiresAt,source:"local-simulation",observedAt:Date.now(),decision,reason:"Approved price condition evaluated"};
      });
      for(let index=0;index<4;index++){
        decision=index===2?"no-action":"allow";
        store.update(user.id,"automation",job.id,{nextRunAt:Date.now()-1000*(index+1)});
        await platform.tick();
        expect(platform.notifications(user).notifications).toHaveLength(index===3?2:1);
      }
      expect(store.list(user.id,"action")).toHaveLength(0);
      const notification=platform.notifications(user).notifications[0];platform.readNotification(user,String(notification.id));
      expect(platform.notifications(user).unreadCount).toBe(1);
    }finally{engine.mockRestore();store.db.close();}
  });
  it("does not move a model proposal to another selected trading account", async () => {
    const store=new Store(":memory:");
    const engine=vi.spyOn(engineBoundary,"callEngine");
    try{
      const user=store.ensureUser("0x1111111111111111111111111111111111111111"),platform=new Platform(store);
      const selected=platform.createAccount(user,{venue:"hyperliquid"});
      const other=platform.createAccount(user,{venue:"uniswap"});
      setBudget(store,user.id,"1","0.1",false);
      engine.mockImplementation(async name=>{
        if(name==="getPortfolio")return {balances:[],positions:[],orders:[],observedAt:Date.now()};
        if(name==="planWith0G")return {message:"Proposed a spot swap",costUsd:"0",proposal:{accountId:other.id,venue:"uniswap",type:"swap",symbol:"WETH/USDC",side:"buy",amount:"1",slippageBps:50,mode:"agent",reduceOnly:false}};
        throw new Error("Unexpected engine call");
      });
      const result=await platform.proposal(user,"Trade using the selected account",selected,"account-mismatch");
      expect(result.proposal).toBeUndefined();
      expect(result.requiresClarification).toBe(true);
      expect(result.message).toContain("different trading account");
      expect(store.list(user.id,"action")).toHaveLength(0);
    }finally{engine.mockRestore();store.db.close();}
  });
  it.each([false,true])("releases reservations for inference rejected before sending (private-only=%s)", async privateOnly => {
    vi.stubEnv("ZEROG_COMPUTE_CHAT_URL", "");
    vi.stubEnv("ZEROG_COMPUTE_API_KEY", "");
    const store=new Store(":memory:");
    try{
      const user=store.ensureUser("0x1111111111111111111111111111111111111111"),platform=new Platform(store);
      setBudget(store,user.id,"1","0.1",false);
      platform.control(user,{command:"update",privateInferenceRequired:privateOnly});
      await expect(platform.proposal(user,"Explain the portfolio",undefined,`preflight-${privateOnly}`)).rejects.toThrow();
      expect(getBudget(store,user.id).reservedUsd).toBe("0.000000");
      expect(getBudget(store,user.id).spentUsd).toBe("0.000000");
    }finally{store.db.close();}
  });
  it("reserves funds atomically, deduplicates charges and retains unknown billing", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser("0x1111111111111111111111111111111111111111");
      setBudget(store, user.id, "1", "0.1", false);
      expect(reserveBudget(store, user.id, "evaluation", "0.75")).toBe(true);
      expect(reserveBudget(store, user.id, "evaluation", "0.75")).toBe(false);
      expect(() => reserveBudget(store, user.id, "another", "0.5")).toThrow("exhausted");
      settleReservation(store, user.id, "evaluation", "unknown");
      expect(getBudget(store, user.id).reservedUsd).toBe("0.750000");
      expect(() => setBudget(store, user.id, "0.1", "0.01", false)).toThrow("reserved");
    } finally { store.db.close(); }
  });
  it("will not renew or release another worker's lease", () => {
    const store = new Store(":memory:");
    try {
      expect(store.takeLease("account", "first", 180_000)).toBe(true);
      expect(store.takeLease("account", "second", 180_000)).toBe(false);
      expect(store.renewLease("account", "second", 180_000)).toBe(false);
      store.releaseLease("account", "second");
      expect(store.renewLease("account", "first", 180_000)).toBe(true);
    } finally { store.db.close(); }
  });
  it("rejects oversized request streams", async () => {
    await expect(readBody(post("budget", { payload: "x".repeat(33_000) }))).rejects.toThrow("too large");
  });
});
