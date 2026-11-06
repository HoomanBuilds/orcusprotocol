import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient,createWalletClient,erc20Abi,formatUnits,getAddress,http,parseAbi,type Hex } from "viem";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { tradeRequestSchema,type TradingAccount } from "@orcus/core";
import { engineConfig,prepareAction,reconcileAction } from "../agent/src/index";

const server=createServer();
await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
const port=(server.address()as{port:number}).port;
await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
const rpcUrl=`http://127.0.0.1:${port}`;
const source=process.env.ORCUS_FORK_SOURCE_RPC??"https://ethereum-sepolia-rpc.publicnode.com";
const anvil=spawn(process.env.ANVIL_PATH??"anvil",["--fork-url",source,"--host","127.0.0.1","--port",String(port),"--chain-id","11155111","--silent"],{stdio:"ignore"});
let startupError=false;
anvil.once("error",()=>{startupError=true;});
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
  assert.equal(await rpc("eth_chainId"),"0xaa36a7");
  assert.ok(["127.0.0.1","localhost"].includes(new URL(rpcUrl).hostname));
  process.env.SEPOLIA_RPC_URL=rpcUrl;
  const owner=privateKeyToAccount(generatePrivateKey()),client=createPublicClient({chain:sepolia,transport:http(rpcUrl)}),wallet=createWalletClient({account:owner,chain:sepolia,transport:http(rpcUrl)});
  const forkBlock=await client.getBlockNumber();
  await rpc("anvil_setBalance",[owner.address,"0x8ac7230489e80000"]);
  const account:TradingAccount={id:"fork-owner",userId:"isolated-verification",venue:"uniswap",address:owner.address,ownerAddress:owner.address,chainId:sepolia.id,status:"connected",controlRevision:0};
  const cfg=engineConfig().uniswap;
  const deposit=await wallet.writeContract({address:getAddress(cfg.weth),abi:parseAbi(["function deposit() payable"]),functionName:"deposit",value:2_000_000_000_000_000n});
  assert.equal((await client.waitForTransactionReceipt({hash:deposit})).status,"success");
  const settled:Record<string,unknown>[]=[];
  for(const side of ["sell","buy"]as const){
    const usdc=await client.readContract({address:getAddress(cfg.usdc),abi:erc20Abi,functionName:"balanceOf",args:[owner.address]});
    const amount=side==="sell"?"0.001":formatUnits(usdc/2n,6);
    const request=tradeRequestSchema.parse({accountId:account.id,venue:"uniswap",type:"swap",symbol:"WETH/USDC",side,amount,slippageBps:50,mode:"manual"});
    const prepared=await prepareAction(request,account);
    let finalHash:Hex|undefined;
    for(const tx of prepared.transactions??[]){
      finalHash=await wallet.sendTransaction({to:getAddress(tx.to),data:tx.data as Hex,value:BigInt(tx.value)});
      assert.equal((await client.waitForTransactionReceipt({hash:finalHash})).status,"success");
    }
    assert.ok(finalHash);
    const result=await reconcileAction({transactionHash:finalHash,prepared},account);
    assert.equal(result.status,"confirmed");
    settled.push({side,amount,transactionHash:finalHash,settlement:result});
  }
  console.log(JSON.stringify({scope:"isolated-sepolia-fork",forkBlock:forkBlock.toString(),publicNetworkWrites:0,contractDeployments:0,verified:"real Uniswap quotes, exact approvals, swaps and token-transfer settlement through application adapters",settled,notProven:["Kernel session execution","Hyperliquid funded execution","public-network transaction settlement"]},null,2));
}finally{
  if(anvil.exitCode===null&&!startupError){anvil.kill("SIGTERM");await Promise.race([new Promise<void>(resolve=>anvil.once("exit",()=>resolve())),delay(3000)]);if(anvil.exitCode===null)anvil.kill("SIGKILL");}
}
