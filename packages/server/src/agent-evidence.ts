const publicTools = ["read_markets", "read_portfolio", "analyze_market", "search_memory", "remember_preference", "forget_memory", "propose_action", "propose_automation"] as const;
type PublicToolName = typeof publicTools[number];
export type PublicAgentToolStep = { name: PublicToolName; ok: boolean; observedAt: number; requestId?: string };
const knownTools = new Set<string>(publicTools);

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function publicRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z\d][a-z\d._:-]{0,199}$/i.test(value)
    && !/^(?:sk|mk|pk)[_-]/i.test(value)
    && !/^(?:0x)?[a-f\d]{64,}$/i.test(value)
    && !/^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/.test(value);
}

export function safeAgentToolSteps(toolTrace: unknown): PublicAgentToolStep[] {
  const steps: PublicAgentToolStep[] = [];
  try {
    if (!Array.isArray(toolTrace)) return steps;
    const length = ownData(toolTrace, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return steps;
    for (let index = 0; index < Math.min(length, 100) && steps.length < 10; index++) {
      const entry = ownData(toolTrace, String(index));
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const name = ownData(entry, "name"), ok = ownData(entry, "ok"), observedAt = ownData(entry, "observedAt");
      if (typeof name !== "string" || !knownTools.has(name) || typeof ok !== "boolean" || typeof observedAt !== "number" || !Number.isSafeInteger(observedAt) || observedAt <= 0) continue;
      const requestId = ownData(entry, "requestId");
      const step: PublicAgentToolStep = { name: name as PublicToolName, ok, observedAt };
      if (publicRequestId(requestId)) step.requestId = requestId;
      steps.push(step);
    }
  } catch { return steps; }
  return steps;
}
