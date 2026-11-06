import { describe,expect,it,vi } from "vitest";

const engine=vi.hoisted(()=>({submit:vi.fn()}));
vi.mock("@orcus/engine",()=>({submitAgentAction:engine.submit}));
import { callEngine } from "./engine";

describe("execution boundary metadata",()=>{
  it("preserves deterministic preflight refusal instead of making it unknown",async()=>{
    engine.submit.mockRejectedValueOnce(Object.assign(new Error("The action expired"),{code:"STALE_ACTION",status:409,phase:"not-submitted"}));
    await expect(callEngine("submitAgentAction")).rejects.toMatchObject({code:"STALE_ACTION",phase:"not-submitted",status:409});
  });
  it("preserves public receipt evidence without copying secret fields",async()=>{
    const hash=`0x${"1".repeat(64)}`;
    engine.submit.mockRejectedValueOnce(Object.assign(new Error("Receipt pending"),{code:"RECEIPT_UNKNOWN",status:502,phase:"submitted-unknown",evidence:{transactionHash:hash,privateKey:"omitted",userOperationHash:"invalid"}}));
    await expect(callEngine("submitAgentAction")).rejects.toMatchObject({phase:"submitted-unknown",evidence:{transactionHash:hash}});
    engine.submit.mockRejectedValueOnce(Object.assign(new Error("Receipt pending"),{code:"RECEIPT_UNKNOWN",status:502,phase:"submitted-unknown",evidence:{transactionHash:hash,privateKey:"omitted"}}));
    try{await callEngine("submitAgentAction");}catch(error){expect((error as{evidence:unknown}).evidence).toEqual({transactionHash:hash});}
  });
});
