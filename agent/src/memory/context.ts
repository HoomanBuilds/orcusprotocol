import { z } from "zod";
import type { AgentCheckpoint, AgentContext, AgentMessage } from "../compute/types";
import { EngineError } from "../errors";
import { redactCredentialMaterial } from "../compute/input-guard";

const messageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(16_000) }).strict();
const checkpointSchema = z.object({ version: z.literal(1), threadId: z.string().min(1).max(200), runId: z.string().min(1).max(200), messageDigest: z.string().length(64), toolProfile: z.enum(["interactive", "strategy"]).optional(), status: z.enum(["running", "completed", "failed"]), modelCalls: z.number().int().min(0).max(12), toolCalls: z.number().int().min(0).max(20), tokenCount: z.number().min(0), messages: z.array(messageSchema).max(24), toolTrace: z.array(z.unknown()).max(12), evidence: z.array(z.unknown()).max(12), inferencePending: z.boolean(), updatedAt: z.number(), proposal: z.unknown().optional(), automationProposal: z.unknown().optional(), summary: z.string().max(4000).optional(), reply: z.unknown().optional() }).strict();

export function safeObservation(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[nested data omitted]";
  if (typeof value === "string") return redactCredentialMaterial(value).slice(0, 2000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 24).map(item => safeObservation(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:private.?key|api.?key|seed.?phrase|mnemonic|password|secret|authorization|signature|token$)/i.test(key)).slice(0, 30).map(([key, item]) => [key, safeObservation(item, depth + 1)]));
  return null;
}

export function compactObservation(value: unknown, maximum = 6000): unknown {
  const safe = safeObservation(value);
  const text = JSON.stringify(safe);
  return text.length <= maximum ? safe : { truncated: true, preview: text.slice(0, maximum), note: "The observation was shortened; do not invent omitted values." };
}

export function boundedMessages(messages: AgentMessage[]): AgentMessage[] {
  let remaining = 14_000;
  const kept: AgentMessage[] = [];
  for (const item of messages.slice(-24).reverse()) {
    if (remaining <= 0) break;
    const content = String(safeObservation(item.content)).slice(0, Math.min(4000, remaining));
    kept.push({ role: item.role, content });
    remaining -= content.length;
  }
  return kept.reverse();
}

export async function loadCheckpoint(context: AgentContext): Promise<AgentCheckpoint | undefined> {
  if (!context.checkpoints) return undefined;
  if (!context.threadId || context.threadId.length > 200) throw new EngineError("INVALID_MEMORY_SCOPE", "Persistent agent memory requires a server-bound personal thread ID.");
  const raw = await context.checkpoints.load(context.threadId);
  if (!raw) return undefined;
  const parsed = checkpointSchema.safeParse(raw);
  if (!parsed.success || parsed.data.threadId !== context.threadId) throw new EngineError("MEMORY_SCOPE_MISMATCH", "The recovered checkpoint does not belong to this personal agent thread.", 409);
  return parsed.data as AgentCheckpoint;
}

export async function saveCheckpoint(context: AgentContext, checkpoint: AgentCheckpoint) {
  if (!context.checkpoints) return;
  if (!context.threadId || checkpoint.threadId !== context.threadId) throw new EngineError("MEMORY_SCOPE_MISMATCH", "A checkpoint cannot be written to another agent's thread.");
  if (JSON.stringify(checkpoint).length > 100_000) throw new EngineError("CHECKPOINT_TOO_LARGE", "The personal agent checkpoint exceeded its bounded context size.");
  await context.checkpoints.save(context.threadId, checkpoint);
}
