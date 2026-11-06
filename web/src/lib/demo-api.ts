import { createDemoData, DEMO_OBSERVED_AT } from "./demo-workspace-data";
import { demoReadOnlyError } from "./demo-mode";

export function demoResponse(path: string, method = "GET"): { handled: false } | { handled: true; data: unknown } {
  if (method.toUpperCase() !== "GET" || !path.startsWith("/api/")) throw demoReadOnlyError();
  const url = new URL(path, "https://orcus.invalid");
  if (["/api/health", "/api/markets", "/api/candles", "/api/market-context"].includes(url.pathname)) return { handled: false };
  const data = createDemoData(DEMO_OBSERVED_AT);
  const routes: Record<string, unknown> = {
    "/api/session": data.session,
    "/api/portfolio": data.portfolio,
    "/api/activity": { actions: data.actions },
    "/api/agent": data.agentData,
    "/api/automations": { automations: data.automations },
    "/api/budget": data.budget,
    "/api/agent/requests": { requests: data.requests },
    "/api/budget/payments": data.payments,
    "/api/budget/funding": data.funding,
    "/api/ostium/allowances": { intents: data.ostiumAllowances },
    "/api/permissions": { permissions: [] },
    "/api/notifications": { notifications: data.notifications },
    "/api/memory": data.memory,
    "/api/wallet-config": { chainId: 11155111, smartAccountsConfigured: false, gasPayment: { mode: "self-funded", payer: "smart-account", maxOperationGasWei: "3000000000000000", chainId: 11155111 } },
    "/api/agent/models": data.models,
  };
  if (!Object.hasOwn(routes, url.pathname)) throw demoReadOnlyError();
  return { handled: true, data: structuredClone(routes[url.pathname]) };
}
