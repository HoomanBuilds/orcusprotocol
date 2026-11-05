import { createCipheriv,createDecipheriv,hkdfSync,randomBytes } from "node:crypto";
import { closeSync,constants,existsSync,fstatSync,openSync,readFileSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { ApiError } from "./errors";
import { dataDirectory,id,type Store } from "./store";

function masterKey():Buffer {
  const value=process.env.ORCUS_MASTER_KEY;
  if(value){const bytes=Buffer.from(value,/^[a-fA-F0-9]{64}$/.test(value)?"hex":"base64");if(bytes.length!==32)throw new ApiError("INVALID_MASTER_KEY","ORCUS_MASTER_KEY must encode 32 random bytes.",503);return bytes;}
  if(process.env.NODE_ENV==="production")throw new ApiError("KEYSTORE_UNCONFIGURED","Set ORCUS_MASTER_KEY before using protected signing in production.",503);
  const path=join(dataDirectory(),"master.key");
  if(!existsSync(path)){try{writeFileSync(path,randomBytes(32),{flag:"wx",mode:0o600});}catch(error){if(!existsSync(path))throw error;}}
  const file=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=fstatSync(file);if((stat.mode&0o077)!==0||!stat.isFile())throw new ApiError("UNSAFE_KEYSTORE","Master key file must be owner-only.",503);const key=readFileSync(file);if(key.length!==32)throw new ApiError("INVALID_MASTER_KEY","Invalid local signing key.",503);return key;}finally{closeSync(file);}
}
function binding(userId:string,keyId:string,kind:string,address:string){return Buffer.from(`${userId}|${keyId}|${kind}|${address.toLowerCase()}`);}
export function createSigner(store:Store,userId:string,kind:string,rotate=false):{id:string;address:string} {
  if(!rotate){const current=store.db.prepare("SELECT id,address FROM secrets WHERE user_id=? AND kind=? ORDER BY created_at DESC LIMIT 1").get(userId,kind) as {id:string;address:string}|undefined;if(current)return current;}
  const key=generatePrivateKey(),address=privateKeyToAccount(key).address,keyId=id(),nonce=randomBytes(12),master=masterKey();
  try{
    const cipher=createCipheriv("aes-256-gcm",master,nonce);cipher.setAAD(binding(userId,keyId,kind,address));
    const encrypted=Buffer.concat([cipher.update(key,"utf8"),cipher.final()]);
    const payload=JSON.stringify({version:1,nonce:nonce.toString("base64"),tag:cipher.getAuthTag().toString("base64"),data:encrypted.toString("base64")});
    store.db.prepare("INSERT INTO secrets(id,user_id,kind,address,payload,created_at) VALUES(?,?,?,?,?,?)").run(keyId,userId,kind,address,payload,Date.now());
    return{id:keyId,address};
  }finally{master.fill(0);}
}
export function readSigner(store:Store,userId:string,kind:string):`0x${string}` {
  const row=store.db.prepare("SELECT * FROM secrets WHERE user_id=? AND kind=? ORDER BY created_at DESC LIMIT 1").get(userId,kind) as {id:string;kind:string;address:string;payload:string}|undefined;
  if(!row)throw new ApiError("SIGNER_UNAVAILABLE","Authorize an agent signer for this account first.",409);
  const payload=JSON.parse(row.payload) as {version:number;nonce:string;tag:string;data:string};
  if(payload.version!==1)throw new ApiError("INVALID_KEYSTORE","Unsupported encrypted key format.",503);
  const master=masterKey();
  try{const decipher=createDecipheriv("aes-256-gcm",master,Buffer.from(payload.nonce,"base64"));decipher.setAAD(binding(userId,row.id,row.kind,row.address));decipher.setAuthTag(Buffer.from(payload.tag,"base64"));const plaintext=Buffer.concat([decipher.update(Buffer.from(payload.data,"base64")),decipher.final()]);try{const key=plaintext.toString("utf8") as `0x${string}`;if(privateKeyToAccount(key).address.toLowerCase()!==row.address.toLowerCase())throw new ApiError("SIGNER_MISMATCH","The protected signer does not match this account.",503);return key;}finally{plaintext.fill(0);}}finally{master.fill(0);}
}
export function memoryKey(store:Store,userId:string):Buffer {
  const master=masterKey();try{return Buffer.from(hkdfSync("sha256",master,Buffer.from(userId),Buffer.from("orcus-agent-memory-v1"),32));}finally{master.fill(0);}
}
