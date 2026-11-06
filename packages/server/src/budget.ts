import type { OperatingBudget } from "@orcus/core";
import { ApiError } from "./errors";
import { id, tokenHash, type Store } from "./store";
import { z } from "zod";
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
function enforceOperatorComputeCaps(store:Store,userId:string,amount:number){
  let userCap:number,projectCap:number;
  try{userCap=micros(process.env.ORCUS_COMPUTE_USER_DAILY_USD??"1");projectCap=micros(process.env.ORCUS_COMPUTE_PROJECT_DAILY_USD??"10");}
  catch{throw new ApiError("COMPUTE_CAP_CONFIG_INVALID","The operator's compute spending ceilings are invalid. No inference was requested.",503);}
  const start=Math.floor(Date.now()/86_400_000)*86_400_000;
  const rows=store.db.prepare("SELECT user_id,SUM(CASE WHEN status IN ('reserved','unknown') THEN amount_micros WHEN status='settled' AND COALESCE(json_extract(evidence,'$.operatorSettledAt'),created_at)>=? THEN amount_micros ELSE 0 END) AS used FROM expenses GROUP BY user_id").all(start)as{user_id:string;used:number}[];
  const used=rows.find(row=>row.user_id===userId)?.used??0,projectUsed=rows.reduce((sum,row)=>sum+row.used,0);
  if(used+amount>userCap)throw new ApiError("OPERATOR_COMPUTE_USER_CAP","This user's operator-paid UTC-day compute ceiling is exhausted or held by unresolved requests. Changing the owner expense cap cannot raise it.",402);
  if(projectUsed+amount>projectCap)throw new ApiError("OPERATOR_COMPUTE_PROJECT_CAP","The shared operator-paid UTC-day compute ceiling is exhausted or held by unresolved requests. No inference was requested.",402);
}
export function getBudget(store:Store,userId:string):OperatingBudget & {lowBalanceUsd:string;autoReplenish:boolean;expenses:NonNullable<OperatingBudget["expenses"]>} {
  const row=store.db.prepare("SELECT * FROM budgets WHERE user_id=?").get(userId) as {cap_micros:number;spent_micros:number;reserved_micros:number;low_micros:number;auto_replenish:number};
  const expenses=store.db.prepare("SELECT id,reference,kind,amount_micros,status,evidence,created_at FROM expenses WHERE user_id=? ORDER BY status IN ('reserved','unknown') DESC,created_at DESC LIMIT 50").all(userId) as {id:string;reference:string;kind:string;amount_micros:number;status:string;evidence:string|null;created_at:number}[];
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
    if(amount<=0)throw new ApiError("INVALID_AMOUNT","A compute reservation must be positive.");
    const result=store.db.prepare("UPDATE budgets SET reserved_micros=reserved_micros+? WHERE user_id=? AND cap_micros-spent_micros-reserved_micros>=?").run(amount,userId,amount);
    if(result.changes!==1)throw new ApiError("INSUFFICIENT_BUDGET","Agent operating budget exhausted. Set an authorized cap or reconcile pending requests.",402);
    enforceOperatorComputeCaps(store,userId,amount);
    reserveServiceCredits(store,userId,reference,amount);
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
    const recorded=evidence&&typeof evidence==="object"&&!Array.isArray(evidence)?{...evidence,operatorSettledAt:Date.now()}:{value:evidence??null,operatorSettledAt:Date.now()};
    store.db.prepare("UPDATE expenses SET status=?,amount_micros=?,evidence=? WHERE user_id=? AND reference=?").run(status,charge,JSON.stringify(recorded),userId,reference);
  }).immediate();
}

export function settleComputeReservation(store:Store,userId:string,reference:string,input:{requestId?:string;billing?:unknown;usage?:unknown;callId?:string;outcome?:"completed"|"rejected"|"unknown";billingOrigin?:string;billingApiKeyId?:string;model?:string}) {
  const billing=parseRouterBilling(input.billing);
  const hasRequestId=typeof input.requestId==="string"&&input.requestId.length>0&&input.requestId.length<=200;
  if(input.outcome==="rejected"){settleReservation(store,userId,reference,"released",{...input,billing:undefined});return;}
  if(!billing||!hasRequestId){settleReservation(store,userId,reference,"unknown",{...input,billing:undefined,recordedBilling:billing,billingStatus:"unverified",reason:"Provider billing and request identity are required before settling an expense."});return;}
  settleReservation(store,userId,reference,"settled",{requestId:input.requestId,callId:input.callId,usage:input.usage,billingOrigin:input.billingOrigin,billingApiKeyId:input.billingApiKeyId,model:input.model,billing,billingStatus:"provider-reported",ledgerUnit:"USD-equivalent",walletDebitCurrency:billing.currency},billing.costUsd);
}

const historyRow = z.object({ request_id: z.string().min(1).max(200), api_key_id: z.string().max(200), model_id: z.string().max(200), canonical_id: z.string().max(200).optional(), cost: z.string().regex(/^(?:0|[1-9]\d{0,79})$/), created_at: z.string().max(50) });
const historyPage = z.object({ object: z.literal("list"), currency: z.enum(["0g", "usd"]), data: z.array(historyRow).max(100), total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), next_cursor: z.string().max(4096).optional() }).refine(value => value.data.length <= value.limit);
const billingContextSchema = z.object({ requestId: z.string().regex(/^[\x21-\x7e]{1,200}$/), billingOrigin: z.enum(["https://router-api.0g.ai", "https://router-api-testnet.integratenetwork.work"]), billingApiKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), model: z.string().min(1).max(200) });
type ComputeExpense = { id: string; reference: string; amount_micros: number; status: string; evidence: string | null; created_at: number };

export async function reconcileComputeExpense(store: Store, userId: string, expenseId: string) {
  const read = () => store.db.prepare("SELECT id,reference,amount_micros,status,evidence,created_at FROM expenses WHERE id=? AND user_id=? AND kind='compute-reservation'").get(expenseId, userId) as ComputeExpense | undefined;
  const expense = read();
  if (!expense) throw new ApiError("COMPUTE_EXPENSE_NOT_FOUND", "This compute expense does not belong to the signed-in wallet.", 404);
  const result = (message: string) => ({ expenseId, status: read()?.status ?? expense.status, message });
  if (!["reserved", "unknown"].includes(expense.status)) return result("This expense was already finalized. No new provider request or charge was made.");
  const context = billingContextSchema.safeParse(expense.evidence ? JSON.parse(expense.evidence) : null);
  if (!context.success) return result("Still reserved: the original call has no complete Router request, API-key, model and network identity. Operator-assisted billing review is required; inference was not retried.");
  const managementKey = process.env.ZEROG_COMPUTE_MANAGEMENT_KEY;
  if (!managementKey) return result("Still reserved: provider billing checks need a server-side management credential with account:read. No inference was requested.");
  const scope = `compute-billing-read:${userId}`, holder = id();
  if (!store.takeLease(scope, holder, 30_000)) throw new ApiError("COMPUTE_RECONCILIATION_BUSY", "A provider billing check is already running for this wallet.", 409);
  try {
    const { requestId, billingOrigin, billingApiKeyId, model } = context.data;
    const start = expense.created_at - 60_000, end = expense.created_at + 86_400_000;
    const matches: Array<z.infer<typeof historyRow>> = [];
    let total: number | undefined, offset = 0, currency: "0g" | "usd" | undefined;
    for (let page = 0; page < 5; page++) {
      const url = new URL("/v1/account/usage/history", billingOrigin);
      for (const [key, value] of Object.entries({ limit: "100", offset: String(offset), include_total: "true", api_key_id: billingApiKeyId, start_date: new Date(start).toISOString().slice(0, 10), end_date: new Date(end).toISOString().slice(0, 10) })) url.searchParams.set(key, value);
      let body: z.infer<typeof historyPage>;
      try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${managementKey}` }, signal: AbortSignal.timeout(5_000), redirect: "error" });
        if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 1_048_576) throw new Error();
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        let text = "", bytes = 0;
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 1_048_576) { await reader.cancel(); throw new Error(); }
            text += decoder.decode(chunk.value, { stream: true });
          }
          body = historyPage.parse(JSON.parse(text + decoder.decode()));
        } finally { reader.releaseLock(); }
      } catch { throw new ApiError("COMPUTE_BILLING_UNAVAILABLE", "Provider billing could not be verified. The expense stays reserved; no inference was retried.", 503); }
      if (total !== undefined && body.total !== total || currency !== undefined && body.currency !== currency || body.offset !== offset) throw new ApiError("COMPUTE_BILLING_CONFLICT", "Provider history changed or returned inconsistent units. The reservation stays held.", 409);
      total = body.total; currency = body.currency;
      if (total > 500) return result("Still reserved: the matching history window exceeds the bounded billing check. Operator-assisted review is required.");
      matches.push(...body.data.filter(row => row.request_id === requestId));
      offset += body.data.length;
      if (offset > total || !body.data.length && offset < total || offset === total && body.next_cursor) throw new ApiError("COMPUTE_BILLING_CONFLICT", "Provider history is incomplete. The reservation stays held.", 409);
      if (offset === total) {
        if (!matches.length) return result("Still reserved: no matching booked provider usage record was found. Absence is not proof of a free request.");
        if (matches.length !== 1) throw new ApiError("COMPUTE_BILLING_CONFLICT", "Provider history contains duplicate request identities. The reservation stays held.", 409);
        const row = matches[0], observed = Date.parse(row.created_at);
        if (row.api_key_id !== billingApiKeyId || ![row.model_id, row.canonical_id].includes(model) || !Number.isFinite(observed) || observed < start || observed > end) throw new ApiError("COMPUTE_BILLING_CONFLICT", "The provider record does not match the original call's API key, model and time window. The reservation stays held.", 409);
        if (currency !== "usd") return result("Still reserved: the provider reports a native 0G cost without a verified per-request USD equivalent. No exchange-rate estimate or zero charge was recorded.");
        const charge = BigInt(row.cost);
        if (charge > BigInt(expense.amount_micros)) return result("Still reserved: the verified provider charge exceeds the original reservation. Operator-assisted review is required.");
        return store.db.transaction(() => {
          const current = read();
          if (!current) throw new ApiError("COMPUTE_EXPENSE_NOT_FOUND", "This compute expense is no longer available.", 404);
          if (!["reserved", "unknown"].includes(current.status)) return result("This expense was already finalized. No duplicate charge was recorded.");
          if (current.evidence !== expense.evidence || current.amount_micros !== expense.amount_micros) throw new ApiError("COMPUTE_BILLING_CONFLICT", "This expense changed during the billing check. Review its current evidence before checking again.", 409);
          const proofId = `compute-billing-proof:${tokenHash(JSON.stringify([billingOrigin, requestId]))}`;
          const existing = store.db.prepare("SELECT body FROM records WHERE id=?").get(proofId) as { body: string } | undefined;
          const settled = store.db.prepare("SELECT id FROM expenses WHERE id<>? AND status='settled' AND json_extract(evidence,'$.requestId')=? AND json_extract(evidence,'$.billingOrigin')=?").get(expenseId, requestId, billingOrigin);
          if (settled || existing && JSON.parse(existing.body).expenseId !== expenseId) throw new ApiError("COMPUTE_BILLING_CONFLICT", "This provider request already belongs to another expense. The reservation stays held.", 409);
          const now = Date.now();
          store.put("compute-billing-proof", { id: proofId, userId, expenseId, requestId, billingOrigin, createdAt: now, updatedAt: now });
          settleReservation(store, userId, expense.reference, "settled", { ...context.data, providerBilledAt: observed, billingStatus: "management-history-verified", billing: { source: "0g-router-history", currency, totalCost: row.cost, totalCostUsdMicro: row.cost, costUsd: usd(Number(charge)) }, ledgerUnit: "USD-equivalent", walletDebitCurrency: currency }, usd(Number(charge)));
          return result("The original provider request was reconciled once from verified billing history. No new inference was requested.");
        }).immediate();
      }
    }
    return result("Still reserved: the provider history could not be completely checked within the bounded read. No inference was requested.");
  } finally { store.releaseLease(scope, holder); }
}
