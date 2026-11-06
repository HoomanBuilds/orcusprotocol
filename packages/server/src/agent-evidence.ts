import { isIP } from "node:net";
import { rejectMemorySecrets } from "./memory";

const publicTools = ["read_markets", "read_portfolio", "analyze_market", "read_market_context", "search_research", "search_memory", "remember_preference", "forget_memory", "propose_action", "propose_automation"] as const;
type PublicToolName = typeof publicTools[number];
export type PublicResearchSource = { id: string; title: string; url: string; retrievedAt: number; publishedAt?: string; network?: string };
export type PublicAgentToolStep = { name: PublicToolName; ok: boolean; observedAt: number; requestId?: string; sources?: PublicResearchSource[] };
const knownTools = new Set<string>(publicTools);
const sourceTools = new Set(["read_markets", "read_portfolio", "analyze_market", "read_market_context", "search_research"]);

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

function safeSources(result: unknown, observedAt: number): PublicResearchSource[] {
  if (!result || typeof result !== "object") return [];
  const sources = ownData(result, "sources");
  if (!Array.isArray(sources)) return [];
  const safe: PublicResearchSource[] = [];
  for (let index = 0; index < 5; index++) {
    const raw = ownData(sources, String(index));
    if (!raw || typeof raw !== "object") continue;
    const id = ownData(raw, "id"), title = ownData(raw, "title"), url = ownData(raw, "url"), retrievedAt = ownData(raw, "retrievedAt");
    if (typeof id !== "string" || !/^[a-z\d:_-]{1,80}$/i.test(id) || typeof title !== "string" || !title.trim() || title.length > 160 || /[<>\r\n]/.test(title) || typeof url !== "string" || url.length > 1500 || typeof retrievedAt !== "number" || !Number.isSafeInteger(retrievedAt) || retrievedAt <= 0 || retrievedAt > observedAt + 5000) continue;
    try {
      rejectMemorySecrets(`${id} ${title} ${url}`);
      const parsed = new URL(url), host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.port && parsed.port !== "443" || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || /0x[a-f\d]{40}/i.test(url) || [...parsed.searchParams.keys()].some(key => /key|token|auth|secret|signature|password|credential/i.test(key))) continue;
      const source: PublicResearchSource = { id, title, url: parsed.href, retrievedAt };
      const publishedAt = ownData(raw, "publishedAt"), network = ownData(raw, "network");
      if (typeof publishedAt === "string" && publishedAt.length <= 40 && Number.isFinite(Date.parse(publishedAt)) && Date.parse(publishedAt) <= retrievedAt) source.publishedAt = publishedAt;
      if (network === "testnet" || network === "mainnet") source.network = network;
      safe.push(source);
    } catch { continue; }
  }
  return safe;
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
      if (ok && sourceTools.has(name)) {
        const sources = safeSources(ownData(entry, "result"), observedAt);
        if (sources.length) step.sources = sources;
      }
      steps.push(step);
    }
  } catch { return steps; }
  return steps;
}
