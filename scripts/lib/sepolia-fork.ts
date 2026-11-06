import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function withSepoliaFork<T>(run:(fork:{rpcUrl:string;rpc:(method:string,params?:unknown[])=>Promise<unknown>})=>Promise<T>){
  const server=createServer();
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const port=(server.address()as{port:number}).port;
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  const rpcUrl=`http://127.0.0.1:${port}`,source=process.env.ORCUS_FORK_SOURCE_RPC??"https://ethereum-sepolia-rpc.publicnode.com";
  const block=process.env.ORCUS_FORK_BLOCK??"12074104";
  assert.match(block,/^\d+$/);
  const anvil=spawn(process.env.ANVIL_PATH??"anvil",["--fork-url",source,"--fork-block-number",block,"--host","127.0.0.1","--port",String(port),"--chain-id","11155111","--silent"],{stdio:"ignore"});
  let startupError=false;anvil.once("error",()=>{startupError=true;});
  const rpc=async(method:string,params:unknown[]=[])=>{
    const response=await fetch(rpcUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:AbortSignal.timeout(15_000)});
    const body=await response.json()as{result:unknown;error?:{message:string}};
    if(!response.ok||body.error)throw new Error(`The isolated fork refused ${method}.`);
    return body.result;
  };
  try{
    let ready=false;
    for(let attempt=0;attempt<100;attempt++){
      if(startupError||anvil.exitCode!==null)throw new Error("Anvil could not start. Install Anvil and check the source RPC.");
      try{if(String(await rpc("web3_clientVersion")).toLowerCase().includes("anvil")){ready=true;break;}}catch{}
      await delay(200);
    }
    if(!ready)throw new Error("The isolated Anvil fork did not become ready.");
    assert.equal(await rpc("eth_chainId"),"0xaa36a7");assert.equal(new URL(rpcUrl).hostname,"127.0.0.1");
    return await run({rpcUrl,rpc});
  }finally{
    if(anvil.exitCode===null&&!startupError){anvil.kill("SIGTERM");await Promise.race([new Promise<void>(resolve=>anvil.once("exit",()=>resolve())),delay(3000)]);if(anvil.exitCode===null)anvil.kill("SIGKILL");}
  }
}
