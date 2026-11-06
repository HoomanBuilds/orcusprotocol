import assert from "node:assert/strict";
import { createPublicClient,createWalletClient,erc20Abi,formatUnits,getAddress,http,parseAbi,type Hex } from "viem";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { tradeRequestSchema,type TradingAccount } from "@orcus/core";
import { engineConfig,prepareAction,reconcileAction } from "../agent/src/index";
import { withSepoliaFork } from "./lib/sepolia-fork";

await withSepoliaFork(async({rpcUrl,rpc})=>{
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
});
