import { compactObservation } from "../memory/context";
import { publicSourceUrl, type ResearchSource } from "./research";
import type { ToolTrace } from "./types";
import { localObservations, uniqueLocalReference } from "./local-evidence";

const evidenceTools = new Set(["read_markets", "read_portfolio", "analyze_market", "read_market_context", "search_research"]);

export function researchSources(value: unknown): ResearchSource[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { sources?: unknown }).sources)) return [];
  return ((value as { sources: unknown[] }).sources).slice(0, 5).flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as ResearchSource, url = publicSourceUrl(item.url);
    if (!url || !/^[a-zA-Z0-9:_-]{1,80}$/.test(item.id) || typeof item.title !== "string" || item.title.length > 160 || !Number.isSafeInteger(item.retrievedAt) || item.retrievedAt <= 0) return [];
    return [{ id: item.id, title: item.title, url, retrievedAt: item.retrievedAt, ...(typeof item.publishedAt === "string" ? { publishedAt: item.publishedAt.slice(0, 40) } : {}), ...(typeof item.network === "string" ? { network: item.network.slice(0, 30) } : {}) }];
  });
}

export function compactToolObservation(value: unknown, maximum = 5000) {
  const safe = compactObservation(value, maximum);
  if (safe && typeof safe === "object" && "truncated" in safe) {
    const sources = researchSources(value).slice(0, 3);
    const sourceLength = JSON.stringify(sources).length;
    return { truncated: true, preview: JSON.stringify(compactObservation(value, Math.max(500, maximum - sourceLength - 150))).slice(0, Math.max(500, maximum - sourceLength - 150)), sources, note: "Only cited sources and the visible excerpt are available; omitted values must not be inferred." };
  }
  return safe;
}

export function requiresObservedResearch(message: string, traces: ToolTrace[]) {
  if (traces.some(trace => evidenceTools.has(trace.name))) return true;
  const current = /\b(?:current|currently|latest|today|now|recent|news|my (?:balance|portfolio|holdings|positions)|research|analyse|analyze)\b/i.test(message);
  if (/^\s*(?:what (?:is|are)|define|explain (?:what|how)|how does)\b/i.test(message) && !current) return false;
  return current || /\b(?:price|balance|portfolio|holdings|funding|open interest|rsi|sma|candles?|order ?book|market analysis)\b/i.test(message);
}

export function groundFinalAnswer(input: { message: string; basis: "observed" | "general"; requiresClarification: boolean; sourceIds?: string[]; observationIds?: string[] }, traces: ToolTrace[], hasProposal: boolean, userMessage = "") {
  const byId = new Map<string, ResearchSource>();
  for (const trace of traces) if (trace.ok && evidenceTools.has(trace.name)) for (const source of researchSources(trace.result)) byId.set(source.id, source);
  const sources = [...byId.values()].slice(-5);
  const local = localObservations(traces);
  const links = input.message.match(/https?:\/\/[^\s<>\])]+/g) ?? [];
  const allowedUrls = new Set(sources.map(source => source.url));
  if (links.some(url => !allowedUrls.has(publicSourceUrl(url) ?? "")) || input.sourceIds?.some(id => !byId.has(id) && !uniqueLocalReference(id, local)) || input.observationIds?.some(id => local.filter(observation => observation.id === id).length !== 1)) return { answer: "I could not verify the sources in that answer. No action was authorized. Ask me to retrieve the relevant market or research sources again.", requiresClarification: true, clearProposal: true };
  if (input.requiresClarification) return { answer: input.message, requiresClarification: true, clearProposal: true };
  const attemptedResearch = traces.some(trace => evidenceTools.has(trace.name));
  if (hasProposal && !sources.length && !attemptedResearch) {
    const draft = [...local].reverse().find(observation => observation.kind === "draft");
    return { answer: draft?.summary ?? "I prepared a draft for your review. No live market rationale was verified and nothing has been activated or executed.", requiresClarification: false, clearProposal: false };
  }
  const needsSources = requiresObservedResearch(userMessage, traces) || /\b(?:currently|today|latest|trading at|your balance is|your holdings|price is|funding is)\b/i.test(input.message);
  if (input.basis === "general" && traces.length === 0 && !needsSources) return { answer: input.message + "\n\nGeneral explanation; no live market or account data was checked.", requiresClarification: false, clearProposal: false };
  const personalMemory = local.filter(observation => observation.kind === "memory");
  if (!sources.length && (!personalMemory.length || needsSources)) return { answer: "I do not have a successful market or research observation for this answer. I cannot verify current prices, news or account facts yet. Please choose a connected market or try again when its data source is available.", requiresClarification: true, clearProposal: true };
  if (!sources.length && personalMemory.length) return { answer: personalMemory.at(-1)!.summary, requiresClarification: false, clearProposal: true };
  const requestedPublicSources = input.sourceIds?.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) ?? [];
  const cited = requestedPublicSources.length ? requestedPublicSources : sources;
  const references = cited.map(source => `[${source.title.replace(/[\[\]<>`\\]/g, "")}](<${source.url}>)`).join(" · ");
  return { answer: input.message + (references ? `\n\nSources: ${references}` : ""), requiresClarification: false, clearProposal: false };
}
