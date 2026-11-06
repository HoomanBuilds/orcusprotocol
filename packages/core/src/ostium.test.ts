import { describe, expect, it } from "vitest";
import { ostiumDelegationAcknowledgementSchema, tradeRequestSchema, venueSchema } from "./index";

const entry={accountId:"owned",venue:"ostium",type:"market",symbol:"XAU/USD",side:"buy",amount:"10",amountUnit:"collateral-usdc",leverage:25.5};
describe("explicit Ostium request and authority contracts",()=>{
  it("accepts explicit USDC collateral without changing legacy base-size semantics",()=>{
    expect(venueSchema.parse("ostium")).toBe("ostium");
    expect(tradeRequestSchema.parse(entry)).toMatchObject({amount:"10",amountUnit:"collateral-usdc",leverage:25.5});
    expect(tradeRequestSchema.parse({accountId:"owned",venue:"hyperliquid",type:"market",symbol:"ETH",side:"buy",amount:"1",leverage:20})).toMatchObject({amount:"1",leverage:20});
  });
  it.each([{amountUnit:undefined},{amountUnit:"base"},{leverage:undefined},{leverage:1000.01},{leverage:1.001},{tokenIn:`0x${"1".repeat(40)}`},{type:"swap"}])("rejects ambiguous or unsupported native entry fields %j",change=>{
    expect(tradeRequestSchema.safeParse({...entry,...change}).success).toBe(false);
  });
  it.each(["close","reduce"])("binds %s to a native position and base size",type=>{
    expect(tradeRequestSchema.safeParse({...entry,type,positionId:"native-position",amountUnit:"base"}).success).toBe(true);
    expect(tradeRequestSchema.safeParse({...entry,type,positionId:"native-position"}).success).toBe(false);
    expect(tradeRequestSchema.safeParse({...entry,type,amountUnit:"base"}).success).toBe(false);
  });
  it.each(["limit","stop"])("requires an explicit %s entry price",type=>{
    expect(tradeRequestSchema.safeParse({...entry,type}).success).toBe(false);
    expect(tradeRequestSchema.safeParse({...entry,type,price:"2000"}).success).toBe(true);
  });
  it("requires an order ID and both protective levels on edits so omissions cannot silently clear them",()=>{
    const edited={...entry,type:"edit-order",orderId:"native-order",price:"2000",stopLoss:"0",takeProfit:"2100"};
    expect(tradeRequestSchema.safeParse(edited).success).toBe(true);
    for(const change of[{orderId:undefined},{price:undefined},{takeProfit:undefined},{stopLoss:undefined}])expect(tradeRequestSchema.safeParse({...edited,...change}).success).toBe(false);
  });
  it("allows zero only for exact native cancellation in explicit base units",()=>{
    const cancel={...entry,type:"cancel",orderId:"pending-open:42",amount:"0",amountUnit:"base"};
    expect(tradeRequestSchema.safeParse(cancel).success).toBe(true);
    expect(tradeRequestSchema.safeParse({...cancel,amount:"0.000"}).success).toBe(true);
    for(const change of[{orderId:undefined},{orderId:""},{amountUnit:undefined},{amountUnit:"collateral-usdc"},{type:"market"},{type:"limit",price:"4000"},{type:"edit-order",price:"4000",takeProfit:"0",stopLoss:"0"},{type:"close",positionId:"native-position"},{type:"reduce",positionId:"native-position"},{type:"add-collateral",positionId:"native-position",amountUnit:"collateral-usdc"},{type:"remove-collateral",positionId:"native-position",amountUnit:"collateral-usdc"}])expect(tradeRequestSchema.safeParse({...cancel,...change}).success).toBe(false);
    for(const venue of["uniswap","hyperliquid"])expect(tradeRequestSchema.safeParse({accountId:"owned",venue,type:"cancel",orderId:"42",symbol:"ETH",side:"buy",amount:"0"}).success).toBe(false);
    for(const amount of["-1","1e-6","","NaN"])expect(tradeRequestSchema.safeParse({...cancel,amount}).success).toBe(false);
  });
  it.each(["stop-loss","take-profit"])("allows an explicit zero to clear a %s level without weakening other venues",type=>{
    const protection={...entry,type,positionId:"native-position",triggerPrice:"0"};
    expect(tradeRequestSchema.safeParse(protection).success).toBe(true);
    expect(tradeRequestSchema.safeParse({...protection,positionId:undefined}).success).toBe(false);
    expect(tradeRequestSchema.safeParse({...protection,...(type==="stop-loss"?{takeProfit:"2000"}:{stopLoss:"2000"})}).success).toBe(false);
    expect(tradeRequestSchema.safeParse({accountId:"owned",venue:"hyperliquid",type,symbol:"ETH",side:"sell",amount:"1",triggerPrice:"0"}).success).toBe(false);
  });
  it.each([2.5,21])("retains Hyperliquid's integer 20x bound for %s",leverage=>{
    expect(tradeRequestSchema.safeParse({accountId:"owned",venue:"hyperliquid",type:"market",symbol:"ETH",side:"buy",amount:"1",leverage}).success).toBe(false);
  });
  it("requires affirmative actor-bound disclosure of native authority",()=>{
    const ack={version:"ostium-native-delegation-v1",chainId:421614,trader:`0x${"1".repeat(40)}`,agentAddress:`0x${"2".repeat(40)}`,nativeNoExpiry:true,applicationLimitsOnly:true,delegateCanRemoveCollateral:true,delegateCanChargeBuilderFees:true,ownerOnlyPermissionChanges:true,payoutsToOwner:true};
    expect(ostiumDelegationAcknowledgementSchema.safeParse(ack).success).toBe(true);
    for(const change of[{nativeNoExpiry:false},{delegateCanRemoveCollateral:false},{delegateCanChargeBuilderFees:undefined},{chainId:42161},{extra:true}])expect(ostiumDelegationAcknowledgementSchema.safeParse({...ack,...change}).success).toBe(false);
  });
});
