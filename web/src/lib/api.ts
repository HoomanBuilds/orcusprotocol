export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    cache: "no-store",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.error) throw new ApiError(result?.error?.code ?? "REQUEST_FAILED", result?.error?.message ?? `Request failed (${response.status}). Please try again.`, response.status);
  return (result && Object.hasOwn(result, "data") ? result.data : result) as T;
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

export function displayError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === 4001) return "Cancelled in your wallet.";
  const message = error instanceof Error ? error.message : "Something went wrong. Please retry.";
  if (/user rejected|user denied/i.test(message)) return "Cancelled in your wallet.";
  if (/insufficient funds/i.test(message)) return "Not enough funds to cover this action and its network fee.";
  if (/fetch|network|ECONNREFUSED/i.test(message)) return "Connection unavailable. Check the service and try again.";
  if (/execution reverted|0x[0-9a-f]{30}/i.test(message)) return "The transaction could not be completed. Refresh your quote and try again.";
  return message.slice(0, 240);
}
