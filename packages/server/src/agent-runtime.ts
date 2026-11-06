import { createHash } from "node:crypto";
import { reserveBudget,settleReservation,settleComputeReservation } from "./budget";
import { ApiError } from "./errors";
import { AgentMemoryStore,memoryInputSchema } from "./memory";
import { id,type Store } from "./store";
import type { StoredRecord } from "./types";

type Progress={stage:string;tool?:string;message?:string;modelCalls?:number;toolCalls?:number};
export type AgentRunStatus=StoredRecord&{modelId?:string;runId?:string;threadId:string;status:"running"|"completed"|"failed";stage:string;tool?:string;modelCalls:number;toolCalls:number;startedAt:number;completedAt?:number;errorCode?:string};
const stages=new Set(["recall","thinking","tool","completed","failed","budget-stop"]);
const preflightCodes=new Set(["COMPUTE_UNCONFIGURED","PRIVATE_INFERENCE_UNAVAILABLE","PRIVATE_INFERENCE_UNVERIFIED","INTEGRATION_UNCONFIGURED","NOT_CONFIGURED","INVALID_MESSAGE","CREDENTIAL_INPUT_REJECTED","TOOL_PROFILE_MISMATCH","INVALID_TOOL_PROFILE","MODEL_UNAVAILABLE","MODEL_NOT_ALLOWED","RUN_MODEL_MISMATCH"]);
export const agentRunRecordId=(userId:string,runId:string)=>`agent-run:${userId}:${runId}`;
export function readAgentRunStatus(store:Store,userId:string,runId:string){return store.get<AgentRunStatus>(userId,"agent-run",agentRunRecordId(userId,runId))??store.get<AgentRunStatus>(userId,"agent-run",runId);}

export class AgentRun{
  readonly memory:AgentMemoryStore;
  readonly scope:string;
  readonly holder=id();
  readonly reservation=process.env.ORCUS_COMPUTE_RESERVATION_USD??"0.01";
  modelCalls=0;
  private initialReservation=false;
  private billingUncertain=false;
  private timer?:ReturnType<typeof setInterval>;
  constructor(readonly store:Store,readonly userId:string,readonly runId:string,readonly message:string,readonly onForget?:(memoryId:string)=>boolean,readonly modelId?:string){this.memory=new AgentMemoryStore(store,userId);this.scope=`agent-thread:${userId}`;}
  start(){
    if(!this.store.takeLease(this.scope,this.holder,180_000))throw new ApiError("AGENT_BUSY","Your agent is still working on another request. Wait for its result before starting another.",409);
    try{
      const previous=this.memory.loadCheckpoint(this.memory.threadId)as{runId?:string;messageDigest?:string;inferencePending?:boolean}|null;
      const canResume=previous?.runId===this.runId&&previous.messageDigest===createHash("sha256").update(this.message).digest("hex")&&!previous.inferencePending;
      this.initialReservation=reserveBudget(this.store,this.userId,this.runId,this.reservation);
      if(!this.initialReservation&&!canResume)throw new ApiError("EVALUATION_PENDING","This request needs inference reconciliation before it can be retried. It will not be charged again automatically.",409);
      this.progress({stage:"recall"});
      this.timer=setInterval(()=>{this.store.renewLease(this.scope,this.holder,180_000);},30_000);this.timer.unref();
    }catch(error){this.close();throw error;}
  }
  private assertLease(){if(!this.store.renewLease(this.scope,this.holder,180_000))throw new ApiError("AGENT_LEASE_LOST","Agent coordination expired. Reconcile this run before retrying.",409);}
  private callReference(callId:string){
    const prefix=`${this.runId}:model:`;
    if(!callId.startsWith(prefix)||!/^\d$/.test(callId.slice(prefix.length))||Number(callId.slice(prefix.length))>=6)throw new ApiError("MODEL_CALL_LIMIT","The agent reached its bounded model-call limit.",409);
    return callId.endsWith(":model:0")?this.runId:callId;
  }
  progress(input:Progress){
    this.assertLease();
    const previous=readAgentRunStatus(this.store,this.userId,this.runId),now=Date.now();
    const stage=stages.has(input.stage)?input.stage:"thinking",tool=input.tool&&/^[a-z][a-z0-9_]{0,59}$/i.test(input.tool)?input.tool:undefined;
    this.store.put("agent-run",{id:agentRunRecordId(this.userId,this.runId),runId:this.runId,modelId:this.modelId??previous?.modelId,userId:this.userId,threadId:this.memory.threadId,status:stage==="completed"?"completed":stage==="failed"?"failed":"running",stage,tool,modelCalls:Math.max(previous?.modelCalls??0,Math.min(6,input.modelCalls??this.modelCalls)),toolCalls:Math.max(previous?.toolCalls??0,Math.min(6,input.toolCalls??0)),startedAt:previous?.startedAt??now,createdAt:previous?.createdAt??now,updatedAt:now,...(stage==="completed"||stage==="failed"?{completedAt:now}:{})}satisfies AgentRunStatus);
  }
  context(){
    const explicitRemember=/\b(remember|save|store|note|prefer|preference)\b/i.test(this.message)&&!/(?:don't|do not|never)\s+(remember|save|store)/i.test(this.message);
    const explicitForget=/\b(forget|delete|remove)\b/i.test(this.message);
    return{
      modelId:this.modelId,threadId:this.memory.threadId,maxModelCalls:6,maxToolCalls:6,maxTotalTokens:12000,timeoutMs:75_000,
      checkpoints:{load:async(threadId:string)=>{this.assertLease();return this.memory.loadCheckpoint(threadId);},save:async(threadId:string,state:unknown)=>{this.assertLease();this.memory.saveCheckpoint(threadId,state);}},
      memoryStore:{search:async(query:string,limit?:number)=>this.memory.search(query,limit),remember:async(input:unknown)=>{if(!explicitRemember)throw new ApiError("MEMORY_CONSENT_REQUIRED","Save memory only when the user explicitly asks to remember a preference or note.",403);const value=memoryInputSchema.parse(input);return this.memory.remember(value,"user-request",this.runId);},forget:async(memoryId:string)=>{if(!explicitForget)throw new ApiError("MEMORY_CONSENT_REQUIRED","Forget memory only when the user explicitly requests it.",403);return this.onForget?this.onForget(memoryId):this.memory.forget(memoryId);}},
      onProgress:async(input:Progress)=>{this.progress(input);},
      modelBudget:{maxCostUsd:this.reservation,beforeCall:async(input:{callId:string;maxTokens:number})=>{
        if(this.billingUncertain)throw new ApiError("INFERENCE_OUTCOME_UNKNOWN","The previous inference charge is unresolved. Reconcile it before any further model call.",409);
        this.assertLease();if(!Number.isSafeInteger(input.maxTokens)||input.maxTokens<=0||input.maxTokens>6000)throw new ApiError("MODEL_TOKEN_LIMIT","The inference token bound is invalid.",409);
        const reference=this.callReference(input.callId);
        if(reference===this.runId){if(!this.initialReservation)throw new ApiError("EVALUATION_PENDING","This first model call was already attempted. A duplicate billable call is blocked.",409);this.initialReservation=false;}
        else if(!reserveBudget(this.store,this.userId,reference,this.reservation))throw new ApiError("EVALUATION_PENDING","This model call is already pending reconciliation.",409);
        this.modelCalls++;this.progress({stage:"thinking",modelCalls:this.modelCalls});
      },afterCall:async(input:{callId:string;outcome:"completed"|"rejected"|"unknown";requestId?:string;usage?:unknown;billing?:unknown;billingOrigin?:string;billingApiKeyId?:string;model?:string})=>{
        const reference=this.callReference(input.callId);
        settleComputeReservation(this.store,this.userId,reference,input);
        const expense=this.store.db.prepare("SELECT status FROM expenses WHERE user_id=? AND reference=?").get(this.userId,reference)as{status:string}|undefined;
        if(!expense||!["settled","released"].includes(expense.status)){
          this.billingUncertain=true;
          throw new ApiError("INFERENCE_OUTCOME_UNKNOWN","The inference charge could not be verified within its reservation. The agent stopped without retrying or requesting another model call.",409);
        }
      }},
    };
  }
  complete(result:{requestId?:string;usage?:unknown;costUsd?:string}){
    if(this.modelCalls===0)settleReservation(this.store,this.userId,this.runId,result.costUsd===undefined?"unknown":"settled",{requestId:result.requestId,usage:result.usage},result.costUsd);
    this.progress({stage:"completed",modelCalls:this.modelCalls});
  }
  fail(error:unknown){
    const code=error instanceof Error&&"code"in error&&typeof error.code==="string"?error.code:"AGENT_RUN_FAILED";
    if(this.modelCalls===0)settleReservation(this.store,this.userId,this.runId,preflightCodes.has(code)?"released":"unknown",{code});
    const run=readAgentRunStatus(this.store,this.userId,this.runId);
    if(run)this.store.put("agent-run",{...run,id:agentRunRecordId(this.userId,this.runId),runId:this.runId,status:"failed",stage:"failed",updatedAt:Date.now(),completedAt:Date.now(),errorCode:code});
  }
  close(){if(this.timer)clearInterval(this.timer);this.store.releaseLease(this.scope,this.holder);}
}
