import { createHash } from "node:crypto";
import { ApiError } from "./errors";
import type { Store } from "./store";
import type { StoredRecord } from "./types";

type CreditReservation = StoredRecord & { amountMicros: number; spentMicros: number; status: "reserved" | "unknown" | "settled" | "released" };
const reservationId = (userId: string, reference: string) => `service-credit:${createHash("sha256").update(JSON.stringify([userId, reference])).digest("hex")}`;

export function servicePaymentMode() {
  const mode = process.env.ORCUS_SERVICE_PAYMENT_MODE ?? "disabled";
  if (mode !== "disabled" && mode !== "testnet") throw new ApiError("SERVICE_PAYMENT_UNCONFIGURED", "Only disabled or testnet service payments are supported. Live payments are not enabled.", 503);
  return mode;
}

export function serviceCreditTotals(store: Store, userId: string) {
  const payments = store.db.prepare("SELECT COALESCE(SUM(json_extract(body,'$.creditsMicros')),0) AS paid FROM records WHERE user_id=? AND kind='service-payment' AND json_extract(body,'$.status')='credited'").get(userId) as { paid: number };
  const rows = (store.db.prepare("SELECT body FROM records WHERE user_id=? AND kind='service-credit-reservation'").all(userId) as { body: string }[]).map(row => JSON.parse(row.body) as CreditReservation);
  const spent = rows.reduce((sum, row) => sum + row.spentMicros, 0), reserved = rows.reduce((sum, row) => sum + (["reserved", "unknown"].includes(row.status) ? row.amountMicros : 0), 0);
  const released = rows.reduce((sum, row) => sum + (["settled", "released"].includes(row.status) ? row.amountMicros - row.spentMicros : 0), 0);
  return { paid: payments.paid, spent, reserved, released, remaining: Math.max(0, payments.paid - spent - reserved) };
}

export function reserveServiceCredits(store: Store, userId: string, reference: string, amountMicros: number) {
  if (servicePaymentMode() === "disabled") return;
  if (serviceCreditTotals(store, userId).remaining < amountMicros) throw new ApiError("INSUFFICIENT_SERVICE_CREDITS", "Verified testnet service credits are too low. Add credits or reconcile pending payments; changing the expense cap does not add credits.", 402);
  const now = Date.now();
  store.put("service-credit-reservation", { id: reservationId(userId, reference), userId, amountMicros, spentMicros: 0, status: "reserved", createdAt: now, updatedAt: now } satisfies CreditReservation);
}

export function settleServiceCredits(store: Store, userId: string, reference: string, status: CreditReservation["status"], spentMicros: number) {
  const id = reservationId(userId, reference), record = store.get<CreditReservation>(userId, "service-credit-reservation", id);
  if (!record || !["reserved", "unknown"].includes(record.status)) return;
  if (!Number.isSafeInteger(spentMicros) || spentMicros < 0 || spentMicros > record.amountMicros) throw new ApiError("SERVICE_CREDIT_CHARGE_INVALID", "The verified service charge exceeds its authorized reservation.", 409);
  store.update<CreditReservation>(userId, "service-credit-reservation", id, { status, spentMicros });
}
