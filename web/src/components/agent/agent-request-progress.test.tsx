import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRequest } from "@orcus/core";
import { describe, expect, it, vi } from "vitest";
import { AgentRequestProgress } from "./agent-request-progress";

vi.mock("../trading/primitives", () => ({ Spinner: () => "Working" }));
function request(status: AgentRequest["status"]): AgentRequest { return { id: "saved", requestId: "saved", runId: "run", userMessageId: "user", message: "Saved instruction", autonomous: false, status, stage: status, modelCalls: 0, toolCalls: 0, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 900_000 }; }
function render(saved: AgentRequest, conversationIds: string[] = []) { return renderToStaticMarkup(React.createElement(AgentRequestProgress, { requests: [saved], conversationIds })); }

describe("durable agent progress", () => {
  it("labels queued work as waiting for the worker rather than active inference", () => {
    const output = render(request("queued"));
    expect(output).toContain("Waiting for worker"); expect(output).toContain("Saved, not yet running");
    expect(output).toContain("Owner signatures are never replayed"); expect(output).not.toContain("model calls");
    expect(output).toContain('class="agent-request-progress"');
    expect(output.indexOf('class="technical-limits"')).toBeGreaterThan(output.indexOf("Saved, not yet running"));
  });
  it("shows a stale heartbeat and an interrupted outcome without a replay button", () => {
    expect(render({ ...request("running"), heartbeatAt: Date.now() - 180_001 })).toContain("heartbeat is stale");
    const output = render({ ...request("interrupted"), error: "Review existing billing; no automatic retry", actionId: "pending-action" });
    expect(output).toContain("interrupted"); expect(output).toContain("Check Activity"); expect(output).not.toContain("<button");
  });
  it("restores saved answer text but does not duplicate an answer already in the conversation", () => {
    const saved = { ...request("completed"), response: { id: "answer", role: "assistant" as const, content: "Saved response after return", createdAt: Date.now() } };
    expect(render(saved)).toContain("Saved response after return");
    expect(render(saved, ["answer"])).not.toContain("Saved response after return");
  });
  it("shows the immutable model snapshot on a saved in-flight request", () => {
    expect(render({ ...request("running"), modelId: "snapshot-model" })).toContain("Model: snapshot-model");
  });
  it.each([
    ["INSUFFICIENT_BUDGET", "Review spending limit", "budget"],
    ["INSUFFICIENT_SERVICE_CREDITS", "Review service credits", "budget"],
    ["OPERATOR_COMPUTE_USER_CAP", "Review compute usage", "budget"],
    ["INFERENCE_OUTCOME_UNKNOWN", "Check existing billing", "budget"],
    ["AGENT_NOT_AUTHORIZED", "Review account access", "accounts"],
    ["COMPUTE_CAP_CONFIG_INVALID", "View service status", "services"],
  ])("links %s to its recovery settings without retrying", (errorCode, label, section) => {
    const output = render({ ...request("failed"), errorCode, error: "Request stopped." });
    expect(output).toContain(`href="/settings?section=${section}"`);
    expect(output).toContain(label);
    expect(output).not.toContain("<button");
  });
  it("does not show recovery controls for an ongoing or unrecognized failure", () => {
    expect(render({ ...request("running"), errorCode: "INSUFFICIENT_BUDGET" })).not.toContain("Review spending limit");
    expect(render({ ...request("failed"), errorCode: "UNRECOGNIZED_FAILURE" })).not.toContain('href="/settings');
  });
});
