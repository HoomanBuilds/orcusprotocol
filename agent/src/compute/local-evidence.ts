import { tradeRequestSchema } from "@orcus/core";
import { automationProposalSchema } from "./automation";
import type { ToolTrace } from "./types";

const localTools = new Set(["search_memory", "remember_preference", "forget_memory", "propose_action", "propose_automation"]);
const reference = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9:_-]{1,200}$/.test(value);
type LocalObservation = { id: string; aliases: string[]; kind: "memory" | "draft"; summary: string };

export function localObservations(traces: ToolTrace[]): LocalObservation[] {
  return traces.flatMap<LocalObservation>((trace, index) => {
    if (!trace.ok || !localTools.has(trace.name)) return [];
    const result = trace.result;
    const id = reference(trace.observationId) ? trace.observationId : `local:${index}:${trace.name}`;
    const aliases = new Set([id, ...(reference(trace.requestId) ? [trace.requestId] : [])]);
    if (trace.name === "search_memory" || trace.name === "remember_preference") {
      const rows = trace.name === "search_memory" ? result : [result];
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || !reference(row.id) || typeof row.content !== "string")) return [];
      for (const row of rows) aliases.add(row.id);
      const notes = rows.slice(0, 5).map(row => JSON.stringify(String(row.content).slice(0, 1000).replace(/https?:\/\/\S+/gi, "[saved link omitted]")));
      const summary = trace.name === "remember_preference"
        ? `Saved your preference: ${notes.join("; ")}. This is your stated preference, not verified market information.`
        : notes.length ? `Your saved preferences: ${notes.join("; ")}. These are your notes, not current market observations.` : "No saved notes matched this search. I did not infer a preference.";
      return [{ id, aliases: [...aliases], kind: "memory" as const, summary }];
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) return [];
    if (trace.name === "forget_memory") {
      const deleted = (result as { deleted?: unknown }).deleted;
      if (typeof deleted !== "boolean") return [];
      return [{ id, aliases: [...aliases], kind: "memory" as const, summary: deleted ? "Deleted the selected saved note." : "The selected saved note was not found; nothing was deleted." }];
    }
    if ((result as { executable?: unknown }).executable !== false) return [];
    if (trace.name === "propose_action") {
      const parsed = tradeRequestSchema.safeParse((result as { proposal?: unknown }).proposal);
      if (!parsed.success) return [];
      const action = parsed.data;
      return [{ id, aliases: [...aliases], kind: "draft" as const, summary: `Prepared the requested ${action.type} ${action.side} draft for ${action.symbol}. Review the exact amount, units and price in the draft before approval. Funding and permissions are checked separately; no trade was placed or authorized.` }];
    }
    const parsed = automationProposalSchema.safeParse((result as { automationProposal?: unknown }).automationProposal);
    if (!parsed.success || (result as { created?: unknown }).created !== false) return [];
    const automation = parsed.data;
    const condition = automation.condition ? ` when ${automation.condition.symbol} is ${automation.condition.operator} the requested threshold ${automation.condition.price}` : " on the requested schedule";
    return [{ id, aliases: [...aliases], kind: "draft" as const, summary: `Prepared your ${automation.kind === "alert" ? "price alert" : "trade automation"} draft${condition}. This is a requested trigger, not a claim about the current price. Review its execution limit and approve explicitly; no job has been created or activated.` }];
  });
}

export function uniqueLocalReference(id: string, observations: LocalObservation[]) {
  return observations.filter(observation => observation.aliases.includes(id)).length === 1;
}
