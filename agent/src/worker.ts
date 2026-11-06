import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.ORCUS_APP_URL ?? "http://127.0.0.1:3000";
const token = process.env.ORCUS_INTERNAL_TOKEN;
if (!token || token.length < 32) throw new Error("ORCUS_INTERNAL_TOKEN must contain at least 32 characters to run the automation worker.");
const configuredInterval = Number(process.env.ORCUS_WORKER_INTERVAL_MS ?? 10_000);
const intervalMs = Number.isFinite(configuredInterval) ? Math.max(5_000, Math.min(300_000, configuredInterval)) : 10_000;
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

while (!abort.signal.aborted) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/internal/tick`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(360_000)]) });
    if (!response.ok) console.error(`Automation worker: HTTP ${response.status}. Jobs remain subject to persisted retry and pause rules.`);
  } catch { if (!abort.signal.aborted) console.error("Automation worker could not reach the application. No local fallback execution was attempted."); }
  try { await delay(intervalMs, undefined, { signal: abort.signal }); } catch { break; }
}
