export function workerConfiguration(environment: NodeJS.ProcessEnv) {
  const baseUrl = environment.ORCUS_INTERNAL_APP_URL?.trim() || environment.ORCUS_APP_URL?.trim() || "http://127.0.0.1:3000";
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("The worker application URL must be an HTTP(S) origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("The worker application URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  const token = environment.ORCUS_INTERNAL_TOKEN;
  if (!token || token.length < 32 || /\s/.test(token)) throw new Error("ORCUS_INTERNAL_TOKEN must contain at least 32 non-whitespace characters to run the automation worker.");
  const configuredInterval = Number(environment.ORCUS_WORKER_INTERVAL_MS ?? 10_000);
  const intervalMs = Number.isFinite(configuredInterval) ? Math.max(5_000, Math.min(300_000, configuredInterval)) : 10_000;
  return { tickUrl: new URL("/api/internal/tick", url).href, token, intervalMs };
}
