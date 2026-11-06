import type { AgentRequest } from "@orcus/core";
import { api, displayError, post } from "./api";

export type AgentRequestDraft = { message: string; accountId?: string; autonomous: boolean; modelId?: string };
export type AgentRequestsState = { owner: string; requests: AgentRequest[]; loading: boolean; submitting: boolean; error: string | null };
export const emptyAgentRequests = (owner = ""): AgentRequestsState => ({ owner, requests: [], loading: false, submitting: false, error: null });
type RequestApi = { list(): Promise<{ requests: AgentRequest[] }>; create(input: AgentRequestDraft & { requestId: string }): Promise<{ request: AgentRequest }> };
const requestApi: RequestApi = { list: () => api("/api/agent/requests"), create: input => post("/api/agent/requests", input) };
const statuses = new Set(["queued", "running", "completed", "failed", "interrupted"]);
function validRequest(request: AgentRequest) { return request && typeof request.id === "string" && request.id === request.requestId && typeof request.message === "string" && statuses.has(request.status); }

export class AgentRequestSession {
  state: AgentRequestsState;
  private active = true;
  private reading = false;
  private readGeneration = 0;
  private retry?: { fingerprint: string; requestId: string };
  constructor(readonly owner: string, private readonly publish: (state: AgentRequestsState) => void, private readonly refresh: () => Promise<void>, private readonly requests: RequestApi = requestApi) { this.state = emptyAgentRequests(owner); }
  private update(patch: Partial<AgentRequestsState>) { if (this.active) { this.state = { ...this.state, ...patch }; this.publish(this.state); } }
  dispose() { this.active = false; this.readGeneration++; }
  get pending() { return this.state.requests.some(request => request.status === "queued" || request.status === "running"); }
  async load() {
    if (!this.active || this.reading) return;
    this.reading = true;
    const generation = ++this.readGeneration;
    this.update({ loading: true });
    try {
      const result = await this.requests.list();
      if (!this.active || generation !== this.readGeneration) return;
      if (!Array.isArray(result.requests) || result.requests.length > 50 || !result.requests.every(validRequest)) throw new Error("Invalid saved request response.");
      const previous = new Map(this.state.requests.map(request => [request.id, request]));
      const changed = result.requests.some(request => request.response && request.response.id !== previous.get(request.id)?.response?.id || !["queued", "running"].includes(request.status) && request.status !== previous.get(request.id)?.status);
      this.update({ requests: result.requests, error: null });
      if (this.retry && result.requests.some(request => request.id === this.retry!.requestId)) this.retry = undefined;
      if (changed && this.active) {
        try { await this.refresh(); }
        catch { this.update({ error: "Saved requests are available, but conversation or balances could not refresh. Reload them without resubmitting the request." }); }
      }
    } catch (cause) { if (this.active && generation === this.readGeneration) this.update({ error: displayError(cause) }); }
    finally { this.reading = false; this.update({ loading: false }); }
  }
  async submit(draft: AgentRequestDraft) {
    if (!this.active || this.state.submitting || !draft.message.trim()) return false;
    const input = { ...draft, message: draft.message.trim() }, fingerprint = JSON.stringify(input);
    const requestId = this.retry?.fingerprint === fingerprint ? this.retry.requestId : crypto.randomUUID();
    this.retry = { fingerprint, requestId };
    this.readGeneration++;
    this.update({ submitting: true, error: null });
    try {
      const result = await this.requests.create({ ...input, requestId });
      if (!this.active) return false;
      if (!validRequest(result.request) || result.request.id !== requestId) throw new Error("Invalid accepted request identity.");
      this.retry = undefined;
      this.update({ requests: [result.request, ...this.state.requests.filter(request => request.id !== requestId)].slice(0, 50) });
      try { await this.refresh(); }
      catch { this.update({ error: "Your request was saved. The conversation could not refresh; do not submit it again." }); }
      return this.active;
    } catch (cause) {
      const error = displayError(cause);
      this.update({ error });
      await this.load();
      const accepted = this.active && this.state.requests.some(request => request.id === requestId);
      if (!accepted) this.update({ error });
      return accepted;
    } finally { this.update({ submitting: false }); }
  }
}
