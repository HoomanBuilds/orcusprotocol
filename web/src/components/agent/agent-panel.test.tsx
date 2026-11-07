import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRequest, ChatMessage } from "@orcus/core";
import type { Workspace } from "@/lib/use-workspace";
import { describe, expect, it, vi } from "vitest";
import { AgentPanel } from "./agent-panel";

const state = vi.hoisted(() => ({ requests: [] as AgentRequest[] }));
vi.mock("@/lib/use-agent-requests", () => ({ useAgentRequests: () => ({ ...state, submitting: false, loading: false, error: null }) }));
vi.mock("@/lib/use-chat-scroll", () => ({ useChatScroll: () => ({ scrollRef: { current: null }, contentRef: { current: null }, away: false }) }));
vi.mock("./agent-model-selector", () => ({ AgentModelSelector: () => null }));
vi.mock("./automation-review-card", () => ({ AutomationSuggestion: ({ automationId }: { automationId?: string }) => automationId ? "Saved automation" : "Draft automation" }));
vi.mock("../trading/primitives", () => ({ Spinner: () => "Working", Badge: ({ children }: { children: React.ReactNode }) => children, InlineError: () => null }));

describe("agent conversation rendering", () => {
  it("renders historical failure before the latest turn and renders each restored message only once", () => {
    const recent: AgentRequest = { id: "recent", requestId: "recent", runId: "recent-run", userMessageId: "recent-user", message: "Recent prompt", autonomous: false, status: "completed", stage: "completed", modelCalls: 1, toolCalls: 0, createdAt: 20, updatedAt: 40, expiresAt: 1000, response: { id: "recent-answer", role: "assistant", content: "Recent reply", createdAt: 40, automationId: "accepted", automationProposal: { kind: "alert" } } };
    const old: AgentRequest = { ...recent, id: "old", requestId: "old", runId: "old-run", userMessageId: "old-user", message: "Earlier prompt", status: "failed", error: "Historical failure", response: undefined, createdAt: 10, updatedAt: 50 };
    state.requests = [recent, old];
    const messages: ChatMessage[] = [recent.response!, { id: "recent-user", role: "user", content: recent.message, createdAt: 20 }];
    const workspace = { session: { user: { address: "0x123" } }, agentData: { agent: { name: "Orcus", mode: "approval-required" }, messages }, refresh: async () => {} } as unknown as Workspace;
    const html = renderToStaticMarkup(<AgentPanel workspace={workspace} onSettings={() => {}} contextControl={null} />);
    expect(html.indexOf("Earlier prompt")).toBeLessThan(html.indexOf("Historical failure"));
    expect(html.indexOf("Historical failure")).toBeLessThan(html.indexOf("Recent prompt"));
    expect(html.indexOf("Recent prompt")).toBeLessThan(html.indexOf("Recent reply"));
    expect(html.match(/Recent prompt/g)).toHaveLength(1);
    expect(html.match(/Recent reply/g)).toHaveLength(1);
    expect(html).toContain("Saved automation");
    expect(html).toContain("Review before execution");
    expect(html).not.toContain("What are we working on?");
  });
});
