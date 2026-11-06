"use client";

import type { AgentRequest } from "@orcus/core";
import { Spinner } from "../trading/primitives";

export function AgentRequestProgress({ requests, conversationIds }: { requests: AgentRequest[]; conversationIds: string[] }) {
  if (!requests.length) return null;
  return <section aria-label="Saved agent requests" className="technical-limits">
    <h3>Saved requests</h3>
    <p className="fine-print">You can leave this page and return. Owner signatures are never replayed automatically.</p>
    {requests.slice(0, 8).map(request => <div className="evaluation" key={request.id}>
      <strong>{request.status === "queued" ? "Waiting for worker" : request.status === "running" ? request.tool ? `Using ${request.tool}` : request.stage : request.status}</strong>
      <p>{request.message}</p>
      {request.status === "queued" && <p className="fine-print">Saved, not yet running. The background worker must be online. This instruction expires at {new Date(request.expiresAt).toLocaleTimeString()}.</p>}
      {request.status === "running" && <span className="agent-thinking"><Spinner />{request.modelCalls} model calls / {request.toolCalls} tool calls</span>}
      {request.status === "running" && (request.heartbeatAt ?? request.updatedAt) < Date.now() - 180_000 && <p className="warning-note">The worker heartbeat is stale. Wait for recovery and review billing or activity; do not resubmit this request.</p>}
      {request.error && <p className="warning-note">{request.error}</p>}
      {request.actionId && <p className="fine-print">An action is recorded. Check Activity for its actual settlement or reconciliation status.</p>}
      {request.response && !conversationIds.includes(request.response.id) && <p>{request.response.content}</p>}
      <details><summary>Request evidence</summary><code>{request.id}</code><p className="fine-print">Updated {new Date(request.updatedAt).toLocaleString()}</p></details>
    </div>)}
  </section>;
}
