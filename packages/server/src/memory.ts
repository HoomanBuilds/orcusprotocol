import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors";
import type { Store } from "./store";
import type { StoredAction } from "./types";

export const memoryInputSchema=z.object({content:z.string().trim().min(1).max(4000),kind:z.enum(["note","preference"]).default("note"),importance:z.number().int().min(0).max(100).default(50)}).strict();
const exportedMemorySchema=z.object({id:z.string().min(1).max(100),kind:z.enum(["note","preference","episode"]),content:z.string().min(1).max(4000),importance:z.number().int().min(0).max(100),source:z.string().max(50),sourceId:z.string().max(150).optional(),createdAt:z.number().int().positive(),updatedAt:z.number().int().positive(),lastAccessedAt:z.number().int().nonnegative()}).strict();
export type AgentMemory=z.infer<typeof exportedMemorySchema>;
type MemoryRow={id:string;kind:AgentMemory["kind"];content:string;importance:number;source:string;source_id:string|null;created_at:number;updated_at:number;last_accessed_at:number};

function fromRow(row:MemoryRow):AgentMemory{return{id:row.id,kind:row.kind,content:row.content,importance:row.importance,source:row.source,sourceId:row.source_id??undefined,createdAt:row.created_at,updatedAt:row.updated_at,lastAccessedAt:row.last_accessed_at};}
function hash(content:string){return createHash("sha256").update(content.trim().normalize("NFKC")).digest("hex");}

export function rejectMemorySecrets(content:string,options:{allowPublicHashes?:boolean;code?:string}={}){
  const credential=/\b(?:sk|mk|pk)[_-][A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:private[\s_-]*key|seed[\s_-]*phrase|mnemonic|api[\s_-]*key|password|secret[\s_-]*key)\s*["']?\s*[:=]\s*["']?[^\s"']+/i.test(content);
  const publicLabel=/\b(?:transaction|tx(?:n)?|request|block|user[ _-]?operation|userop|storage[ _-]?root|root|order)(?:[ _-]?(?:hash|id))?\s*[:=]?\s*$/i;
  const ambiguousHash=[...content.matchAll(/\b0x[\da-fA-F]{64}\b/g)].some(match=>!options.allowPublicHashes||!publicLabel.test(content.slice(Math.max(0,match.index-64),match.index)));
  if(credential||ambiguousHash)throw new ApiError(options.code??"MEMORY_SECRET_REJECTED","Keep wallet credentials, API keys and raw secret-like values out of agent memory and conversation.");
}

export class AgentMemoryStore{
  constructor(readonly store:Store,readonly userId:string){}
  get threadId(){return`agent:${this.userId}`;}

  remember(input:unknown,source="user",sourceId?:string):AgentMemory{
    const value=memoryInputSchema.parse(input);rejectMemorySecrets(value.content);
    return this.write({...value,source,sourceId});
  }
  private write(input:{content:string;kind:AgentMemory["kind"];importance:number;source:string;sourceId?:string},restore?:AgentMemory):AgentMemory{
    const contentHash=hash(input.content),memoryId=createHash("sha256").update(`${this.userId}|${input.kind}|${contentHash}`).digest("hex");
    const existing=this.store.db.prepare("SELECT * FROM agent_memories WHERE user_id=? AND kind=? AND content_hash=?").get(this.userId,input.kind,contentHash)as MemoryRow|undefined;
    const count=(this.store.db.prepare("SELECT COUNT(*) AS count FROM agent_memories WHERE user_id=?").get(this.userId)as{count:number}).count;
    if(!existing&&count>=1000)throw new ApiError("MEMORY_LIMIT","Your agent memory is full. Forget unneeded notes before saving more.",409);
    const now=Date.now(),createdAt=existing?.created_at??restore?.createdAt??now;
    this.store.db.prepare("INSERT INTO agent_memories(id,user_id,kind,content,content_hash,importance,source,source_id,created_at,updated_at,last_accessed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,kind,content_hash) DO UPDATE SET importance=MAX(agent_memories.importance,excluded.importance),updated_at=excluded.updated_at,last_accessed_at=excluded.last_accessed_at").run(memoryId,this.userId,input.kind,input.content.trim(),contentHash,input.importance,input.source,input.sourceId??null,createdAt,now,restore?.lastAccessedAt??now);
    if(!restore)this.store.db.prepare("DELETE FROM agent_memory_tombstones WHERE user_id=? AND memory_id=?").run(this.userId,memoryId);
    return fromRow(this.store.db.prepare("SELECT * FROM agent_memories WHERE user_id=? AND id=?").get(this.userId,memoryId)as MemoryRow);
  }
  episode(action:StoredAction){
    if(!["confirmed","rejected","cancelled"].includes(action.status))return;
    if(this.store.db.prepare("SELECT 1 FROM agent_memories WHERE user_id=? AND kind='episode' AND source_id=?").get(this.userId,action.id))return;
    const content=`${action.initiator} ${action.request.side} ${action.request.amount} ${action.request.symbol} on ${action.request.venue}: ${action.status}. Action type: ${action.request.type}. Action ${action.id}.`;
    this.write({content,kind:"episode",importance:action.status==="rejected"?70:40,source:"execution-journal",sourceId:action.id});
  }
  search(query:string,limit=8):AgentMemory[]{
    if(query.length>2000)throw new ApiError("MEMORY_QUERY_TOO_LONG","Keep memory searches below 2,000 characters.");
    const size=Math.max(1,Math.min(50,Math.trunc(limit))),terms=[...new Set(query.match(/[\p{L}\p{N}_]+/gu)??[])].slice(0,12);
    const rows=terms.length?this.store.db.prepare("SELECT m.* FROM agent_memory_search JOIN agent_memories m ON m.rowid=agent_memory_search.rowid WHERE agent_memory_search MATCH ? AND m.user_id=? ORDER BY bm25(agent_memory_search),m.importance DESC,m.updated_at DESC LIMIT ?").all(terms.map(term=>`\"${term}\"`).join(" OR "),this.userId,size)as MemoryRow[]:this.store.db.prepare("SELECT * FROM agent_memories WHERE user_id=? ORDER BY importance DESC,updated_at DESC LIMIT ?").all(this.userId,size)as MemoryRow[];
    const touched=Date.now();for(const row of rows)this.store.db.prepare("UPDATE agent_memories SET last_accessed_at=? WHERE user_id=? AND id=?").run(touched,this.userId,row.id);
    return rows.map(row=>({...fromRow(row),lastAccessedAt:touched}));
  }
  context(query:string){
    const preferred=this.store.db.prepare("SELECT * FROM agent_memories WHERE user_id=? AND kind='preference' ORDER BY importance DESC,updated_at DESC LIMIT 3").all(this.userId)as MemoryRow[];
    const selected=new Map(preferred.map(row=>[row.id,fromRow(row)]));
    for(const memory of this.search(query.slice(0,2000),8))if(selected.size<8)selected.set(memory.id,memory);
    let remaining=12_000;
    return [...selected.values()].map(memory=>{const content=memory.content.slice(0,Math.min(2000,remaining));remaining-=content.length;return{...memory,content};}).filter(memory=>memory.content.length>0);
  }
  forget(memoryId:string):boolean{
    return this.store.db.transaction(()=>{
      const removed=this.store.db.prepare("DELETE FROM agent_memories WHERE user_id=? AND id=?").run(this.userId,memoryId).changes>0;
      if(removed)this.store.db.prepare("INSERT OR REPLACE INTO agent_memory_tombstones(user_id,memory_id,deleted_at) VALUES(?,?,?)").run(this.userId,memoryId,Date.now());
      return removed;
    })();
  }
  get(memoryId:string):AgentMemory|undefined{const row=this.store.db.prepare("SELECT * FROM agent_memories WHERE user_id=? AND id=?").get(this.userId,memoryId)as MemoryRow|undefined;return row?fromRow(row):undefined;}
  wasForgotten(content:string,kind:AgentMemory["kind"]="preference"){const memoryId=createHash("sha256").update(`${this.userId}|${kind}|${hash(content)}`).digest("hex");return Boolean(this.store.db.prepare("SELECT 1 FROM agent_memory_tombstones WHERE user_id=? AND memory_id=?").get(this.userId,memoryId));}
  list(limit=50):AgentMemory[]{return(this.store.db.prepare("SELECT * FROM agent_memories WHERE user_id=? ORDER BY updated_at DESC LIMIT ?").all(this.userId,Math.max(1,Math.min(200,Math.trunc(limit))))as MemoryRow[]).map(fromRow);}
  loadCheckpoint(threadId:string):unknown|null{
    if(threadId!==this.threadId)throw new ApiError("THREAD_MISMATCH","The checkpoint belongs to a different personal agent.",403);
    const row=this.store.db.prepare("SELECT state FROM agent_checkpoints WHERE user_id=? AND thread_id=?").get(this.userId,threadId)as{state:string}|undefined;
    return row?JSON.parse(row.state):null;
  }
  saveCheckpoint(threadId:string,state:unknown){
    if(threadId!==this.threadId)throw new ApiError("THREAD_MISMATCH","The checkpoint belongs to a different personal agent.",403);
    if(state&&typeof state==="object"&&"threadId"in state&&state.threadId!==threadId)throw new ApiError("THREAD_MISMATCH","Checkpoint state belongs to a different personal agent.",403);
    const encoded=JSON.stringify(state);
    if(!encoded||Buffer.byteLength(encoded)>131_072)throw new ApiError("CHECKPOINT_LIMIT","Agent checkpoints must remain below 128 KiB.",413);
    if(/"(?:privateKey|private_key|apiKey|api_key|authorization|mnemonic|seedPhrase|password)"\s*:/i.test(encoded))throw new ApiError("CHECKPOINT_SECRET_REJECTED","Credentials must not enter the agent checkpoint.");
    this.store.db.prepare("INSERT INTO agent_checkpoints(user_id,thread_id,state,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,thread_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at").run(this.userId,threadId,encoded,Date.now());
  }
  snapshot(){return{notes:(this.store.db.prepare("SELECT * FROM agent_memories WHERE user_id=? ORDER BY importance DESC,updated_at DESC LIMIT 200").all(this.userId)as MemoryRow[]).map(fromRow),checkpoint:this.loadCheckpoint(this.threadId)};}
  restoreNotes(notes:unknown){
    const parsed=z.array(exportedMemorySchema).max(200).parse(notes);
    return this.store.db.transaction(()=>{
      let restored=0;
      for(const note of parsed){
        rejectMemorySecrets(note.content);
        const expectedId=createHash("sha256").update(`${this.userId}|${note.kind}|${hash(note.content)}`).digest("hex");
        if(note.id!==expectedId)throw new ApiError("MEMORY_OWNER_MISMATCH","The backup note is not bound to this agent.",403);
        if(this.store.db.prepare("SELECT 1 FROM agent_memory_tombstones WHERE user_id=? AND memory_id=?").get(this.userId,note.id))continue;
        this.write(note,note);restored++;
      }
      return restored;
    })();
  }
}
