export const DEMO_MODE_KEY = "orcus:demo-account:v1";
export const DEMO_READ_ONLY_MESSAGE = "Demo account is read-only. Exit demo to use your wallet, run inference or submit actions.";
let walletOperations = 0;
let lastKnownMode = false;

export function isDemoMode() {
  if (typeof window === "undefined") return false;
  try { lastKnownMode = window.localStorage.getItem(DEMO_MODE_KEY) === "enabled"; } catch {}
  return lastKnownMode;
}

export function demoReadOnlyError() {
  return Object.assign(new Error(DEMO_READ_ONLY_MESSAGE), { code: "DEMO_READ_ONLY", status: 403 });
}

export function hasDemoTarget(path: string, body?: BodyInit | null) {
  if (/\/demo-[^/?#]+/.test(path)) return true;
  if (typeof body !== "string") return false;
  const fields = new Set(["accountId", "actionId", "userId", "ownerId", "permissionId", "messageId", "intentId", "automationId"]);
  const inspect = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > 8) return false;
    return Object.entries(value).some(([key, item]) => fields.has(key) && typeof item === "string" && item.startsWith("demo-") || inspect(item, depth + 1));
  };
  try { return inspect(JSON.parse(body), 0); } catch { return false; }
}

export function setDemoMode(enabled: boolean) {
  if (walletOperations > 0) throw Object.assign(new Error("Finish or dismiss the current wallet request before changing accounts."), { code: "DEMO_WALLET_BUSY" });
  if (enabled) window.localStorage.setItem(DEMO_MODE_KEY, "enabled");
  else window.localStorage.removeItem(DEMO_MODE_KEY);
  if (isDemoMode() !== enabled) throw new Error("Demo preference could not be saved.");
}

export function guardWalletAction<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>) {
  return async (...args: Args): Promise<Result> => {
    if (isDemoMode()) throw demoReadOnlyError();
    walletOperations += 1;
    try { return await action(...args); } finally { walletOperations -= 1; }
  };
}
