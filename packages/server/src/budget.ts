import type { OperatingBudget } from "@orcus/core";
import { ApiError } from "./errors";
import { id, type Store } from "./store";
import { parseRouterBilling } from "@orcus/engine/budget";
import { reserveServiceCredits, settleServiceCredits } from "./service-credits";

export function micros(value:string):number {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value)) throw new ApiError("INVALID_AMOUNT","Use a non-negative USD amount with at most six decimal places.");
  const [whole,fraction=""]=value.split(".");
  const amount=BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,"0"));
  if (amount>100_000_000_000n) throw new ApiError("INVALID_AMOUNT","Operating amounts cannot exceed $100,000.");
  return Number(amount);
}
export function usd(value:number):string {return `${Math.floor(value/1_000_000)}.${String(value%1_000_000).padStart(6,"0")}`;}
export function getBudget(store:Store,userId:string):OperatingBudget & {lowBalanceUsd:string;autoReplenish:boolean;expenses:NonNullable<OperatingBudget["expenses"]>} {
  const row=store.db.prepare("SELECT * FROM budgets WHERE user_id=?").get(userId) as {cap_micros:number;spent_micros:number;reserved_micros:number;low_micros:number;auto_replenish:number};
  const expenses=store.db.prepare("SELECT id,reference,kind,amount_micros,status,evidence,created_at FROM expenses WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(userId) as {id:string;reference:string;kind:string;amount_micros:number;status:string;evidence:string|null;created_at:number}[];
  return {operatingAddress:"",limitUsd:usd(row.cap_micros),spentUsd:usd(row.spent_micros),reservedUsd:usd(row.reserved_micros),availableUsd:usd(Math.max(0,row.cap_micros-row.spent_micros-row.reserved_micros)),lowBalanceUsd:usd(row.low_micros),autoReplenish:Boolean(row.auto_replenish),computeBalanceStatus:"unconfigured",replenishmentStatus:"unconfigured",warning:"This is an authorized expense cap, not proof of funded compute credits.",expenses:expenses.map(item=>({...item,amountUsd:usd(item.amount_micros),evidence:item.evidence?JSON.parse(item.evidence):null}))};
}
export function setBudget(store:Store,userId:string,cap:string,low:string,auto:boolean) {
  return store.db.transaction(()=>{
    const capMicros=micros(cap),current=getBudget(store,userId);
    if(capMicros<micros(current.spentUsd)+micros(current.reservedUsd))throw new ApiError("BUDGET_RESERVED","The cap cannot be lower than spent or reserved expenses.");
    store.db.prepare("UPDATE budgets SET cap_micros=?,low_micros=?,auto_replenish=? WHERE user_id=?").run(capMicros,micros(low),Number(auto),userId);
    return getBudget(store,userId);
  })();
}
export function reserveBudget(store:Store,userId:string,reference:string,amountUsd:string):boolean {
  return store.db.transaction(()=>{
    if(store.db.prepare("SELECT id FROM expenses WHERE user_id=? AND reference=?").get(userId,reference))return false;
    const amount=micros(amountUsd);
    reserveServiceCredits(store,userId,reference,amount);
    const result=store.db.prepare("UPDATE budgets SET reserved_micros=reserved_micros+? WHERE user_id=? AND cap_micros-spent_micros-reserved_micros>=?").run(amount,userId,amount);
    if(result.changes!==1)throw new ApiError("INSUFFICIENT_BUDGET","Agent operating budget exhausted. Set an authorized cap or reconcile pending requests.",402);
    store.db.prepare("INSERT INTO expenses(id,user_id,reference,kind,amount_micros,status,created_at) VALUES(?,?,?,?,?,?,?)").run(id(),userId,reference,"compute-reservation",amount,"reserved",Date.now());
    return true;
  }).immediate();
}
export function settleReservation(store:Store,userId:string,reference:string,status:"released"|"unknown"|"settled",evidence?:unknown,actualUsd?:string) {
  store.db.transaction(()=>{
    const row=store.db.prepare("SELECT * FROM expenses WHERE user_id=? AND reference=?").get(userId,reference) as {amount_micros:number;status:string}|undefined;
    if(!row||!["reserved","unknown"].includes(row.status))return;
    if(status==="unknown"){settleServiceCredits(store,userId,reference,"unknown",0);store.db.prepare("UPDATE expenses SET status=?,evidence=? WHERE user_id=? AND reference=?").run(status,JSON.stringify(evidence??null),userId,reference);return;}
    const charge=status==="settled"&&actualUsd!==undefined?micros(actualUsd):0;
    if(charge>row.amount_micros){settleServiceCredits(store,userId,reference,"unknown",0);store.db.prepare("UPDATE expenses SET status='unknown',evidence=? WHERE user_id=? AND reference=?").run(JSON.stringify({billingStatus:"exceeds-reservation",evidence}),userId,reference);return;}
    settleServiceCredits(store,userId,reference,status,charge);
    store.db.prepare("UPDATE budgets SET reserved_micros=MAX(0,reserved_micros-?),spent_micros=spent_micros+? WHERE user_id=?").run(row.amount_micros,charge,userId);
    store.db.prepare("UPDATE expenses SET status=?,amount_micros=?,evidence=? WHERE user_id=? AND reference=?").run(status,charge,JSON.stringify(evidence??null),userId,reference);
  })();
}

export function settleComputeReservation(store:Store,userId:string,reference:string,input:{requestId?:string;billing?:unknown;usage?:unknown;callId?:string;outcome?:"completed"|"rejected"|"unknown"}) {
  const billing=parseRouterBilling(input.billing);
  const hasRequestId=typeof input.requestId==="string"&&input.requestId.length>0&&input.requestId.length<=200;
  if(input.outcome==="rejected"){settleReservation(store,userId,reference,"released",{...input,billing:undefined});return;}
  if(!billing||!hasRequestId){settleReservation(store,userId,reference,"unknown",{...input,billing:undefined,recordedBilling:billing,billingStatus:"unverified",reason:"Provider billing and request identity are required before settling an expense."});return;}
  settleReservation(store,userId,reference,"settled",{requestId:input.requestId,callId:input.callId,usage:input.usage,billing,billingStatus:"provider-reported",ledgerUnit:"USD-equivalent",walletDebitCurrency:billing.currency},billing.costUsd);
}
