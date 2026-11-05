import { OrcusError } from "@orcus/core";

export { OrcusError as EngineError };

export function requireConfigured(value: string | undefined, name: string): string {
  if (!value) throw new OrcusError("NOT_CONFIGURED", `${name} is not configured. Ask the operator to configure this integration.`, 503);
  return value;
}

export async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new OrcusError("UPSTREAM_UNAVAILABLE", "The upstream service is unavailable or timed out. Refresh account state before retrying an action.", 502);
  }
  if (!response.ok) throw new OrcusError("UPSTREAM_REJECTED", `The upstream service returned HTTP ${response.status}.`, 502);
  return response.json() as Promise<T>;
}
