import { describe,expect,it } from "vitest";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRun } from "./agent-runtime";
import { getBudget,setBudget } from "./budget";
import { AgentMemoryStore,rejectMemorySecrets } from "./memory";
import { Store } from "./store";

describe("durable personal agent memory",()=>{
  it("recalls saved notes and checkpoints after reopening the database",()=>{
    const directory=mkdtempSync(join(tmpdir(),"orcus-memory-restart-")),path=join(directory,"memory.sqlite");
    let store=new Store(path);
    try{
      const user=store.ensureUser("0x1111111111111111111111111111111111111111"),memory=new AgentMemoryStore(store,user.id);
      const note=memory.remember({content:"Prefer bounded ETH orders",kind:"preference"});
      memory.saveCheckpoint(memory.threadId,{threadId:memory.threadId,runId:"saved-run",status:"completed"});
      store.db.close();store=new Store(path);
      const recovered=new AgentMemoryStore(store,user.id);
      expect(recovered.search("ETH")[0].id).toBe(note.id);
      expect(recovered.loadCheckpoint(recovered.threadId)).toMatchObject({runId:"saved-run"});
    }finally{if(store.db.open)store.db.close();rmSync(directory,{recursive:true,force:true});}
  });
  it("rejects management and inference credentials but permits public hashes in chat",()=>{
    for(const prefix of ["mk-","mk_","sk-","sk_"]){const generated=`${prefix}${"example".repeat(4)}`;expect(()=>rejectMemorySecrets(generated)).toThrow("credentials");expect(()=>rejectMemorySecrets(generated,{allowPublicHashes:true})).toThrow("credentials");}
    const publicHash=`0x${"a".repeat(64)}`;
    expect(()=>rejectMemorySecrets(`Inspect transaction ${publicHash}`,{allowPublicHashes:true})).not.toThrow();
    expect(()=>rejectMemorySecrets(publicHash,{allowPublicHashes:true})).toThrow("credentials");
    expect(()=>rejectMemorySecrets(`private_key: ${publicHash}`,{allowPublicHashes:true})).toThrow("credentials");
  });
  it("uses scoped full-text retrieval, deduplication and bounded context",()=>{
    const store=new Store(":memory:");
    try{
      const first=store.ensureUser("0x1111111111111111111111111111111111111111"),second=store.ensureUser("0x2222222222222222222222222222222222222222");
      const alice=new AgentMemoryStore(store,first.id),bob=new AgentMemoryStore(store,second.id);
      const preference=alice.remember({content:"Prefer ETH limit orders with low slippage",kind:"preference",importance:90});
      expect(alice.remember({content:preference.content,kind:"preference",importance:90}).id).toBe(preference.id);
      bob.remember({content:"Private BTC preference",kind:"preference"});
      expect(alice.search("ETH limit")[0].id).toBe(preference.id);
      expect(alice.search("BTC")).toHaveLength(0);
      expect(bob.get(preference.id)).toBeUndefined();
      expect(alice.context("x".repeat(3000)).length).toBeLessThanOrEqual(8);
      expect(store.list(first.id,"permission")).toHaveLength(0);
    }finally{store.db.close();}
  });
  it("does not restore forgotten notes or accept another user's checkpoint",()=>{
    const store=new Store(":memory:");
    try{
      const user=store.ensureUser("0x1111111111111111111111111111111111111111"),memory=new AgentMemoryStore(store,user.id);
      const note=memory.remember({content:"Keep planning concise"}),snapshot=memory.snapshot();
      expect(memory.forget(note.id)).toBe(true);
      expect(memory.restoreNotes(snapshot.notes)).toBe(0);
      memory.saveCheckpoint(memory.threadId,{threadId:memory.threadId,runId:"run",status:"completed"});
      expect(memory.loadCheckpoint(memory.threadId)).toMatchObject({runId:"run"});
      expect(()=>memory.loadCheckpoint("agent:another-user")).toThrow("different personal agent");
      expect(()=>memory.saveCheckpoint(memory.threadId,{apiKey:"not-a-real-key"})).toThrow("Credentials");
      expect(()=>memory.remember({content:`Secret ${"0x"+"1".repeat(64)}`})).toThrow("credentials");
    }finally{store.db.close();}
  });
  it("reserves each model call separately and does not persist progress text",async()=>{
    const store=new Store(":memory:");let run:AgentRun|undefined;
    try{
      const user=store.ensureUser("0x1111111111111111111111111111111111111111");setBudget(store,user.id,"1","0.1",false);
      run=new AgentRun(store,user.id,"run","Remember I prefer ETH");run.start();
      const context=run.context();
      await context.modelBudget.beforeCall({callId:"run:model:0",maxTokens:1000});
      await context.modelBudget.afterCall({callId:"run:model:0",outcome:"completed",requestId:"actual-provider-request"});
      await context.modelBudget.beforeCall({callId:"run:model:1",maxTokens:1000});
      await context.onProgress({stage:"tool",tool:"read_portfolio",message:"This private text must not be stored"});
      expect(getBudget(store,user.id).reservedUsd).toBe("0.020000");
      await expect(context.modelBudget.beforeCall({callId:"run:model:0",maxTokens:1000})).rejects.toThrow("duplicate");
      expect(JSON.stringify(store.get(user.id,"agent-run","run"))).not.toContain("private text");
      await context.memoryStore.remember({content:"Prefer ETH",kind:"preference"});
      expect(context.threadId).toBe(`agent:${user.id}`);
    }finally{run?.close();store.db.close();}
  });
});
