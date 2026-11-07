import type { AgentRequest, ChatMessage } from "@orcus/core";
import { describe, expect, it } from "vitest";
import { conversationTimeline } from "./conversation-timeline";

function request(id: string, createdAt: number, status: AgentRequest["status"] = "queued"): AgentRequest {
  return { id, requestId: id, runId: id, userMessageId: `${id}:user`, message: "Draft an ETH alert", autonomous: false, status, stage: status, modelCalls: 0, toolCalls: 0, createdAt, updatedAt: createdAt, expiresAt: createdAt + 900_000 };
}
function answer(id: string, createdAt: number): ChatMessage {
  return { id: `${id}:assistant`, role: "assistant", content: "Here is the draft", createdAt };
}

describe("conversation timeline", () => {
  it("keeps an older failed request beside its prompt rather than below the latest answer", () => {
    const old = { ...request("old", 10, "failed"), updatedAt: 1000, error: "Expense allowance too low" };
    const recent = { ...request("recent", 20, "completed"), response: answer("recent", 30) };
    expect(conversationTimeline([recent.response], [recent, old]).map(entry => entry.id)).toEqual([
      "old:user", "request:old", "recent:user", "recent:assistant",
    ]);
  });

  it("replaces restored prompt and answer fallbacks by stable message ID on refresh", () => {
    const saved = { ...request("run", 10, "completed"), response: answer("run", 30) };
    const before = conversationTimeline([], [saved]);
    const persisted: ChatMessage[] = [
      { id: "run:user", role: "user", content: saved.message, createdAt: 10 },
      { ...saved.response, automationId: "accepted-job", automationProposal: { kind: "alert" } },
    ];
    const after = conversationTimeline(persisted, [saved]);
    expect(after.map(entry => entry.id)).toEqual(before.map(entry => entry.id));
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ kind: "message", message: { automationId: "accepted-job" } });
  });

  it("preserves separate intentional requests with identical text", () => {
    const first = request("first", 10, "failed"), second = request("second", 20);
    const entries = conversationTimeline([], [second, first]);
    expect(entries.filter(entry => entry.kind === "message").map(entry => entry.id)).toEqual(["first:user", "second:user"]);
  });

  it("keeps slow answers and progress attached to their original turn", () => {
    const slow = { ...request("slow", 10, "running"), response: answer("slow", 40) };
    const newer = request("newer", 20);
    expect(conversationTimeline([], [newer, slow]).map(entry => entry.id)).toEqual([
      "slow:user", "slow:assistant", "request:slow", "newer:user", "request:newer",
    ]);
  });

  it("orders standalone history, resolves duplicate IDs, and leaves source arrays unchanged", () => {
    const messages = [answer("new", 30), answer("old", 10), answer("new", 30)];
    const original = JSON.stringify(messages);
    expect(conversationTimeline(messages, []).map(entry => entry.id)).toEqual(["old:assistant", "new:assistant"]);
    expect(JSON.stringify(messages)).toBe(original);
    expect(conversationTimeline([], [])).toEqual([]);
  });

  it("uses a deterministic turn order when timestamps tie and API ordering changes", () => {
    const a = { ...request("a", 10, "completed"), response: answer("a", 10) };
    const b = request("b", 10);
    const expected = ["a:user", "a:assistant", "b:user", "request:b"];
    expect(conversationTimeline([], [b, a]).map(entry => entry.id)).toEqual(expected);
    expect(conversationTimeline([], [a, b]).map(entry => entry.id)).toEqual(expected);
  });

  it("retains interrupted execution evidence even when an answer exists", () => {
    const saved = { ...request("run", 10, "interrupted"), response: answer("run", 20), actionId: "uncertain-action" };
    expect(conversationTimeline([saved.response], [saved]).map(entry => entry.id)).toEqual(["run:user", "run:assistant", "request:run"]);
  });
});
