import { isAbsolute } from "node:path";

export function inferencePreviewEnvironment(source, runtime, host = {}) {
  const validOrigin = value => {
    try { const url = new URL(value); return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === "3132" && url.origin === value; }
    catch { return false; }
  };
  if (!validOrigin(runtime.ORCUS_APP_URL) || !validOrigin(runtime.ORCUS_INTERNAL_APP_URL)) throw new Error("Evaluation origins must use HTTP loopback on port 3132.");
  if (!runtime.ORCUS_DATA_DIR || !isAbsolute(runtime.ORCUS_DATA_DIR)) throw new Error("An isolated absolute data directory is required.");
  if (!runtime.ORCUS_MASTER_KEY || !runtime.ORCUS_INTERNAL_TOKEN) throw new Error("Persistent isolated runtime secrets are required.");
  if (!source.ZEROG_COMPUTE_API_KEY || !source.ZEROG_COMPUTE_MODEL || !source.ZEROG_COMPUTE_CHAT_URL) throw new Error("Configure the inference key, model and chat URL before evaluation.");
  const env = {
    NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=1024",
    ORCUS_APP_URL: runtime.ORCUS_APP_URL, ORCUS_INTERNAL_APP_URL: runtime.ORCUS_INTERNAL_APP_URL,
    ORCUS_DATA_DIR: runtime.ORCUS_DATA_DIR, ORCUS_MASTER_KEY: runtime.ORCUS_MASTER_KEY, ORCUS_INTERNAL_TOKEN: runtime.ORCUS_INTERNAL_TOKEN,
    ORCUS_COMPUTE_PROJECT_DAILY_USD: "0.05", ORCUS_COMPUTE_USER_DAILY_USD: "0.05", ORCUS_COMPUTE_RESERVATION_USD: "0.01",
    ORCUS_SERVICE_PAYMENT_MODE: "disabled", CRE_ENABLED: "false", ZEROG_STORAGE_ENABLED: "false",
  };
  for (const name of ["PATH", "HOME", "TMPDIR"]) if (host[name]) env[name] = host[name];
  for (const name of ["ZEROG_COMPUTE_API_KEY", "ZEROG_COMPUTE_MODEL", "ZEROG_COMPUTE_CHAT_URL", "ZEROG_COMPUTE_API_KEY_ID"]) if (source[name]) env[name] = source[name];
  return env;
}
