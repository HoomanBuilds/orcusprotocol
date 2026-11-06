import assert from "node:assert/strict";
import { serializePermissionAccount,deserializePermissionAccount } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { createKernelAccount } from "@zerodev/sdk";
import { concatHex,createPublicClient,createWalletClient,encodeFunctionData,erc20Abi,formatUnits,getAddress,http,parseAbi,parseEventLogs,parseUnits,toHex,type Address,type Hex } from "viem";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi,type UserOperation } from "viem/account-abstraction";
import { sepolia } from "viem/chains";
import { tradeRequestSchema,type PreparedAction,type TradingAccount } from "@orcus/core";
import { createOwnerKernel,createPermissionPlugin,entryPoint,kernelVersion,type KernelGrantPolicy } from "../packages/wallets/src/kernel";
import { assertKernelPolicyCompatible,inspectPreparedSwap,swapCallAbi } from "../packages/wallets/src/preflight";
import { engineConfig,prepareAction,reconcileAction } from "../agent/src/index";
import { withSepoliaFork } from "./lib/sepolia-fork";

await withSepoliaFork(async({rpcUrl,rpc})=>{
  process.env.SEPOLIA_RPC_URL=rpcUrl;
  const owner=privateKeyToAccount(generatePrivateKey()),session=privateKeyToAccount(generatePrivateKey()),payer=privateKeyToAccount(generatePrivateKey());
  const client=createPublicClient({chain:sepolia,transport:http(rpcUrl)}),wallet=createWalletClient({account:payer,chain:sepolia,transport:http(rpcUrl)}),config={rpcUrl,bundlerUrl:rpcUrl};
  const cfg=engineConfig().uniswap,kernel=await createOwnerKernel(config,owner),forkBlock=await client.getBlockNumber();
  assert.ok(await client.getCode({address:entryPoint.address}));
  await rpc("anvil_setBalance",[payer.address,"0x8ac7230489e80000"]);
  await rpc("anvil_setBalance",[kernel.account.address,"0xde0b6b3a7640000"]);
  const account:TradingAccount={id:"kernel-fork",userId:"isolated-verification",venue:"uniswap",address:kernel.account.address,smartAccountAddress:kernel.account.address,ownerAddress:owner.address,agentAddress:session.address,chainId:11155111,status:"authorized",controlRevision:0};
  const receipts:Record<string,unknown>[]=[];
  async function execute(signer:typeof kernel.account,calls:{to:Address;data:Hex;value:bigint}[],label:string){
    const factory=await signer.getFactoryArgs();
    const operation:UserOperation<"0.7">={sender:signer.address,nonce:await signer.getNonce(),callData:await signer.encodeCalls(calls),callGasLimit:900_000n,verificationGasLimit:8_000_000n,preVerificationGas:100_000n,maxFeePerGas:100_000_000n,maxPriorityFeePerGas:1_000_000n,signature:"0x",...factory};
    operation.signature=await signer.signUserOperation(operation);
    const packed={sender:operation.sender,nonce:operation.nonce,initCode:operation.factory?concatHex([operation.factory,operation.factoryData??"0x"]):"0x"as Hex,callData:operation.callData,accountGasLimits:concatHex([toHex(operation.verificationGasLimit,{size:16}),toHex(operation.callGasLimit,{size:16})]),preVerificationGas:operation.preVerificationGas,gasFees:concatHex([toHex(operation.maxPriorityFeePerGas,{size:16}),toHex(operation.maxFeePerGas,{size:16})]),paymasterAndData:"0x"as Hex,signature:operation.signature};
    try{await client.simulateContract({account:payer.address,address:entryPoint.address,abi:entryPoint07Abi,functionName:"handleOps",args:[[packed],payer.address]});}
    catch(error){
      const trace=await rpc("debug_traceCall",[{from:payer.address,to:entryPoint.address,data:encodeFunctionData({abi:entryPoint07Abi,functionName:"handleOps",args:[[packed],payer.address]})},"latest",{tracer:"callTracer"}]);
      const failures:unknown[]=[];const visit=(node:Record<string,unknown>)=>{if(node.error)failures.push({to:node.to,error:node.error,gas:node.gas,gasUsed:node.gasUsed,output:node.output});for(const child of node.calls as Record<string,unknown>[]??[])visit(child);};visit(trace as Record<string,unknown>);
      const reason=(error as Error).message.match(/AA\d+[^,\n)]*/u)?.[0]??"";
      throw new Error(`${label}: ${(error as {shortMessage?:string}).shortMessage??"EntryPoint validation failed"} ${reason} ${JSON.stringify(failures)}`);
    }
    const hash=await wallet.writeContract({address:entryPoint.address,abi:entryPoint07Abi,functionName:"handleOps",args:[[packed],payer.address],gas:12_000_000n});
    const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,"success");
    const event=parseEventLogs({abi:entryPoint07Abi,logs:receipt.logs,eventName:"UserOperationEvent"});assert.equal(event.length,1);assert.equal(event[0].args.success,true,`${label} account execution failed`);
    receipts.push({label,transactionHash:hash,userOperationHash:event[0].args.userOpHash,success:true});return hash;
  }
  const transactions=(prepared:PreparedAction)=>prepared.transactions!.map(tx=>({to:getAddress(tx.to),data:tx.data as Hex,value:BigInt(tx.value)}));
  await execute(kernel.account,[{to:getAddress(cfg.weth),data:encodeFunctionData({abi:parseAbi(["function deposit() payable"]),functionName:"deposit"}),value:3_000_000_000_000_000n}],"owner-wrap");
  const request=tradeRequestSchema.parse({accountId:account.id,venue:"uniswap",type:"swap",symbol:"WETH/USDC",side:"sell",amount:"0.001",slippageBps:50,mode:"manual"});
  const ownerPrepared=await prepareAction(request,account),ownerHash=await execute(kernel.account,transactions(ownerPrepared),"owner-swap");assert.equal((await reconcileAction({transactionHash:ownerHash,prepared:ownerPrepared},account)).status,"confirmed");
  const ownerNative=await prepareAction({...request,nativeInput:true},account),nativeOwnerHash=await execute(kernel.account,transactions(ownerNative),"owner-native-input-swap");assert.equal((await reconcileAction({transactionHash:nativeOwnerHash,prepared:ownerNative},account)).status,"confirmed");
  const prepared=await prepareAction({...request,mode:"agent",nativeInput:true},account),now=Date.now();
  assert.ok(prepared.quote?.minimumOut);assert.equal(prepared.request.tokenOutDecimals,6);
  const minimum=parseUnits(prepared.quote.minimumOut,6);
  const policy:KernelGrantPolicy={accountAddress:account.address,agentAddress:session.address,router:cfg.router,swaps:[{tokenIn:cfg.weth,tokenOut:cfg.usdc,feeTier:500,maxAmountIn:"1000000000000000",minAmountOut:minimum.toString()}],nativeWrap:{weth:cfg.weth,maxAmountWei:"1000000000000000"},issuedAt:now,expiresAt:now+3_600_000,maxGasWei:"3000000000000000"};
  await rpc("evm_setNextBlockTimestamp",[Math.max(Number((await client.getBlock()).timestamp)+1,Math.floor(now/1000)+1)]);await rpc("evm_mine");
  const regular=await createPermissionPlugin(config,policy),enrolled=await createKernelAccount(client,{entryPoint,kernelVersion,plugins:{sudo:kernel.sudo,regular}}),approval=await serializePermissionAccount(enrolled);
  const signing=await toECDSASigner({signer:session}),authorized=await deserializePermissionAccount(client,entryPoint,kernelVersion,approval,signing);
  assertKernelPolicyCompatible(prepared,policy);
  const sessionHash=await execute(authorized,transactions(prepared),"agent-session-native-input-swap");assert.equal((await reconcileAction({transactionHash:sessionHash,prepared},account)).status,"confirmed");
  const nonceKey=(await authorized.getNonce())>>64n,readNonce=()=>client.readContract({address:entryPoint.address,abi:entryPoint07Abi,functionName:"getNonce",args:[authorized.address,nonceKey]}),sessionNonce=await readNonce();
  await assert.rejects(execute(authorized,[{to:getAddress(cfg.weth),data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[payer.address,1n]}),value:0n}],"forbidden-token-transfer"),/handleOps.*reverted/u);
  await assert.rejects(execute(authorized,[{to:payer.address,data:"0x",value:1n}],"forbidden-native-transfer"),/handleOps.*reverted/u);
  await assert.rejects(execute(authorized,[{to:getAddress(cfg.weth),data:"0xd0e30db0",value:1_000_000_000_000_001n}],"forbidden-native-wrap-overspend"),/handleOps.*reverted/u);
  const {router,deadline,...swap}=inspectPreparedSwap(prepared);
  const altered=encodeFunctionData({abi:swapCallAbi,functionName:"exactInputSingle",args:[{...swap,recipient:payer.address}]});
  await assert.rejects(execute(authorized,[...transactions(prepared).slice(0,-1),{to:router,data:encodeFunctionData({abi:swapCallAbi,functionName:"multicall",args:[deadline,[altered]]}),value:0n}],"forbidden-output-recipient"),/handleOps.*reverted/u);
  assert.equal(await readNonce(),sessionNonce);
  const wrappedBefore=await client.readContract({address:getAddress(cfg.weth),abi:erc20Abi,functionName:"balanceOf",args:[authorized.address]});
  await execute(authorized,[{to:getAddress(cfg.weth),data:"0xd0e30db0",value:1_000_000_000_000_000n},{to:getAddress(cfg.weth),data:"0xd0e30db0",value:1_000_000_000_000_000n}],"repeated-bounded-wrap-keeps-user-ownership");
  assert.equal(await client.readContract({address:getAddress(cfg.weth),abi:erc20Abi,functionName:"balanceOf",args:[authorized.address]}),wrappedBefore+2_000_000_000_000_000n);
  const usdc=await client.readContract({address:getAddress(cfg.usdc),abi:erc20Abi,functionName:"balanceOf",args:[kernel.account.address]});
  const ownerExit=await prepareAction({...request,side:"buy",amount:formatUnits(usdc/2n,6)},account),exitHash=await execute(kernel.account,transactions(ownerExit),"owner-manages-agent-holdings");assert.equal((await reconcileAction({transactionHash:exitHash,prepared:ownerExit},account)).status,"confirmed");
  await rpc("evm_setNextBlockTimestamp",[Math.floor(policy.expiresAt/1000)+1]);await rpc("evm_mine");
  await assert.rejects(execute(authorized,transactions(prepared),"expired-agent-grant"),/AA22/u);
  console.log(JSON.stringify({scope:"isolated-sepolia-fork",forkBlock:forkBlock.toString(),publicNetworkWrites:0,protocolDeployments:0,localKernelAccountsCreated:1,verified:["owner-signed WETH and native ETH input trading","owner-enrolled bounded native wrapping permission","agent-signed native ETH input swap in same Kernel account","owner management of agent-acquired holdings","native rejection of token/native transfer, wrapping overspend and changed output recipient","repeated bounded wrapping retains WETH ownership in the same user account","native rejection after grant expiry"],receipts,notProven:["native ETH swap output (not supported)","external bundler compatibility","public-network funded execution","Hyperliquid funded execution"]},null,2));
});
