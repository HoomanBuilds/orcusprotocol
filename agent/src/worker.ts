import { setTimeout as delay } from "node:timers/promises";
import { workerConfiguration } from "./worker-config";

const { tickUrl, token, intervalMs } = workerConfiguration(process.env);
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

while (!abort.signal.aborted) {
  try {
    const response = await fetch(tickUrl, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(360_000)]) });
    if (!response.ok) console.error(`Automation worker: HTTP ${response.status}. Jobs remain subject to persisted retry and pause rules.`);
  } catch { if (!abort.signal.aborted) console.error("Automation worker could not reach the application. No local fallback execution was attempted."); }
  try { await delay(intervalMs, undefined, { signal: abort.signal }); } catch { break; }
}
