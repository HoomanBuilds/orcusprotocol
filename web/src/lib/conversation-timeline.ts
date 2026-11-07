import type { AgentRequest, ChatMessage } from "@orcus/core";

export type ConversationEntry =
  | { kind: "message"; id: string; message: ChatMessage }
  | { kind: "request"; id: string; request: AgentRequest };

export function conversationTimeline(messages: ChatMessage[], requests: AgentRequest[]): ConversationEntry[] {
  const saved = new Map(messages.map(message => [message.id, message]));
  const runs = new Map(requests.map(request => [request.id, request]));
  const positions = new Map<string, { at: number; turn: string; order: number }>();
  const activity: ConversationEntry[] = [];
  for (const request of runs.values()) {
    if (!saved.has(request.userMessageId)) saved.set(request.userMessageId, {
      id: request.userMessageId, role: "user", content: request.message,
      createdAt: request.createdAt, modelId: request.modelId,
    });
    const turn = request.userMessageId;
    const at = saved.get(turn)!.createdAt;
    positions.set(turn, { at, turn, order: 0 });
    if (request.response) {
      if (!saved.has(request.response.id)) saved.set(request.response.id, request.response);
      positions.set(request.response.id, { at, turn, order: 1 });
    }
    if (request.status !== "completed" || !request.response) {
      const id = `request:${request.id}`;
      activity.push({ kind: "request", id, request });
      positions.set(id, { at, turn, order: 2 });
    }
  }
  const entries: ConversationEntry[] = [...saved.values()].map(message => ({ kind: "message", id: message.id, message }));
  entries.push(...activity);
  const position = (entry: ConversationEntry) => positions.get(entry.id) ?? { at: entry.kind === "message" ? entry.message.createdAt : entry.request.createdAt, turn: entry.id, order: 0 };
  return entries.sort((left, right) => {
    const a = position(left), b = position(right);
    return a.at - b.at || a.turn.localeCompare(b.turn) || a.order - b.order || left.id.localeCompare(right.id);
  });
}
