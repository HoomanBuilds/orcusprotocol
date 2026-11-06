import { beforeEach,describe,expect,it,vi } from "vitest";
import { tradeRequestSchema,type TradingAccount } from "@orcus/core";
import { engineConfig } from "../../config";

const rpc=vi.hoisted(()=>({getChainId:vi.fn(),readContract:vi.fn(),getCode:vi.fn(),getBalance:vi.fn(),simulateContract:vi.fn()}));
vi.mock("viem",async importOriginal=>({...await importOriginal<typeof import("viem")>(),createPublicClient:()=>rpc}));
import { prepareUniswapAction } from "./index";

const address="0x1111111111111111111111111111111111111111";
const account:TradingAccount={id:"native-account",userId:"user",venue:"uniswap",address,smartAccountAddress:address,ownerAddress:"0x2222222222222222222222222222222222222222",chainId:11155111,status:"authorized",controlRevision:0};
const request=()=>tradeRequestSchema.parse({accountId:account.id,venue:"uniswap",type:"swap",symbol:"WETH/USDC",side:"sell",amount:"0.001",nativeInput:true});

beforeEach(()=>{
  vi.clearAllMocks();const cfg=engineConfig().uniswap;
  rpc.getChainId.mockResolvedValue(11155111);rpc.getCode.mockResolvedValue("0x6000");rpc.getBalance.mockResolvedValue(10n**18n);
  rpc.readContract.mockImplementation(async({functionName,address}:{functionName:string;address:string})=>{
    if(functionName==="decimals")return address.toLowerCase()===cfg.weth.toLowerCase()?18:6;
    if(functionName==="allowance")return 0n;
    if(functionName==="getPool")return"0x3333333333333333333333333333333333333333";
    throw new Error(`Unexpected contract read ${functionName}`);
  });
  rpc.simulateContract.mockResolvedValue({result:[2_000_000n,0n,0,100_000n]});
});

describe("atomic native ETH swap planning",()=>{
  it("prepends only the exact WETH deposit and preserves exact allowance and protected output",async()=>{
    const prepared=await prepareUniswapAction(request(),account),cfg=engineConfig().uniswap;
    expect(prepared.kind).toBe("user-operation");expect(prepared.transactions).toHaveLength(3);
    expect(prepared.transactions![0]).toMatchObject({data:"0xd0e30db0",value:"1000000000000000",chainId:11155111});expect(prepared.transactions![0].to.toLowerCase()).toBe(cfg.weth.toLowerCase());
    expect(prepared.transactions!.slice(1).every(call=>call.value==="0")).toBe(true);expect(prepared.quote?.minimumOut).toBe("1.99");
  });
  it("rejects insufficient native balance before presenting an executable quote",async()=>{
    rpc.getBalance.mockResolvedValue(999_999_999_999_999n);
    await expect(prepareUniswapAction(request(),account)).rejects.toMatchObject({code:"INSUFFICIENT_NATIVE_BALANCE"});expect(rpc.simulateContract).not.toHaveBeenCalled();
  });
  it("requires atomic smart-account execution and the verified WETH to USDC pair",async()=>{
    await expect(prepareUniswapAction(request(),{...account,smartAccountAddress:undefined})).rejects.toMatchObject({code:"NATIVE_INPUT_ACCOUNT_REQUIRED"});
    await expect(prepareUniswapAction({...request(),tokenIn:engineConfig().uniswap.usdc},account)).rejects.toMatchObject({code:"NATIVE_INPUT_PAIR_UNSUPPORTED"});
  });
  it("leaves ordinary WETH input unchanged and does not wrap existing holdings implicitly",async()=>{
    const prepared=await prepareUniswapAction({...request(),nativeInput:undefined},account);
    expect(prepared.transactions).toHaveLength(2);expect(prepared.transactions!.every(call=>call.value==="0")).toBe(true);expect(rpc.getBalance).not.toHaveBeenCalled();
  });
});
