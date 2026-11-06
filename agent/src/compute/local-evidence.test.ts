import { describe, expect, it } from "vitest";
import { groundFinalAnswer } from "./grounding";
import { researchSource } from "./research";
import type { ToolTrace } from "./types";

const note = { id: "80ddac876db6428545254dd901cc128cf4acab45ba78ba8b27d3f6de20425953", content: "I prefer spot trading without leverage." };
const memory: ToolTrace = { name: "remember_preference", observationId: "observation:memory-write", ok: true, observedAt: Date.now(), requestId: "memory-request", arguments: {}, result: note };
const request = { accountId: "fixture-account", venue: "hyperliquid", type: "limit", symbol: "ETH/USDC", side: "buy", amount: "0.001", slippageBps: 50, price: "1000", mode: "agent" };
const draft: ToolTrace = { name: "propose_action", observationId: "observation:draft", ok: true, observedAt: Date.now(), requestId: "e99fe048-1ae0-4cd5-907c-8fbb50dceefe", arguments: {}, result: { proposal: request, executable: false } };
const final = { message: "Done.", requiresClarification: false, basis: "observed" as const };

describe("local tool evidence is not public market evidence", () => {
  it("retains the successful draft when a final cites its actual correlated request ID", () => {
    const output = groundFinalAnswer({ ...final, message: `The limit buy proposal for 0.001 ETH at 1000 USDC on Hyperliquid has been drafted (sourceId: ${draft.requestId}). However, it is not executable because the account is unfunded. No trade was placed or authorized.`, sourceIds: [draft.requestId!] }, [draft], true, "For a preview only draft a limit buy of 0.001 ETH at 1000 USDC.");
    expect(output).toMatchObject({ requiresClarification: false, clearProposal: false });
    expect(output.answer).toContain("requested limit buy draft");
    expect(output.answer).toContain("Funding and permissions are checked separately");
    expect(output.answer).not.toContain("account is unfunded");
    expect(output.answer).not.toContain("0.001 ETH/USDC");
  });
  it("accepts current observation IDs and legacy real memory identifiers without adding public citations", () => {
    for (const citations of [{ observationIds: [memory.observationId!] }, { sourceIds: [memory.requestId!] }, { sourceIds: [note.id] }]) {
      const output = groundFinalAnswer({ ...final, ...citations }, [memory], false, "Remember my preference.");
      expect(output).toMatchObject({ requiresClarification: false, clearProposal: true });
      expect(output.answer).toContain("Saved your preference");
      expect(output.answer).toContain("spot trading without leverage");
      expect(output.answer).not.toContain("Sources:");
    }
  });
  it("renders actual recalled notes and distinguishes an empty successful search", () => {
    const recall = { ...memory, name: "search_memory", result: [note] };
    expect(groundFinalAnswer({ ...final, sourceIds: [note.id] }, [recall], false, "Recall my saved preference").answer).toContain("Your saved preferences");
    expect(groundFinalAnswer({ ...final, observationIds: [recall.observationId!] }, [{ ...recall, result: [] }], false, "Recall my saved preference").answer).toContain("No saved notes matched");
  });
  it.each([
    { sourceIds: ["invented-id"] },
    { observationIds: ["observation:invented"] },
    { sourceIds: [memory.requestId!] },
    { message: "See https://fabricated.example.com/report" },
  ])("rejects unsupported references instead of dropping the guard: %j", change => {
    expect(groundFinalAnswer({ ...final, ...change }, [draft], true).clearProposal).toBe(true);
  });
  it("does not accept failed or ambiguous local references", () => {
    expect(groundFinalAnswer({ ...final, sourceIds: [draft.requestId!] }, [{ ...draft, ok: false }], true).requiresClarification).toBe(true);
    expect(groundFinalAnswer({ ...final, sourceIds: [note.id] }, [memory, { ...memory, observationId: "observation:recall", name: "search_memory", result: [note] }], false).requiresClarification).toBe(true);
  });
  it("does not treat unavailable memory or arbitrary tool names as successful evidence", () => {
    for (const trace of [{ ...memory, result: { available: false } }, { ...memory, name: "unregistered_tool" }]) expect(groundFinalAnswer({ ...final, sourceIds: [memory.requestId!] }, [trace], false).requiresClarification).toBe(true);
  });
  it("cannot use a saved note to substantiate a current price or balance", () => {
    const output = groundFinalAnswer({ ...final, message: "ETH is currently 9000.", sourceIds: [note.id] }, [memory], false, "What is the current price?");
    expect(output).toMatchObject({ requiresClarification: true, clearProposal: true });
    expect(output.answer).not.toContain("9000");
  });
  it("keeps failed mixed research closed even if a valid draft tool also succeeded", () => {
    const failed: ToolTrace = { name: "search_research", ok: false, arguments: {}, result: { error: "unavailable" }, observedAt: Date.now() };
    expect(groundFinalAnswer({ ...final, sourceIds: [draft.requestId!] }, [failed, draft], true, "Research ETH and draft a trade")).toMatchObject({ requiresClarification: true, clearProposal: true });
  });
  it("does not mistake a requested alert threshold for a live price assertion", () => {
    const alert: ToolTrace = { ...draft, name: "propose_automation", result: { executable: false, created: false, automationProposal: { kind: "alert", accountId: "fixture-account", name: "ETH below threshold", condition: { symbol: "ETH", operator: "below", price: "1000" }, executionMode: "once", maxExecutions: 1, intervalSeconds: 300 } } };
    const output = groundFinalAnswer({ ...final, observationIds: [alert.observationId!] }, [alert], true, "Draft an alert when ETH price is below 1000.");
    expect(output).toMatchObject({ requiresClarification: false, clearProposal: false });
    expect(output.answer).toContain("requested threshold 1000");
    expect(output.answer).toContain("no job has been created");
  });
  it("appends real public citations even if the final only references its local observation", () => {
    const source = researchSource("Hyperliquid testnet", "https://api.hyperliquid-testnet.xyz/info", Date.now());
    const market: ToolTrace = { name: "read_markets", ok: true, arguments: {}, result: { sources: [source] }, observedAt: Date.now() };
    const output = groundFinalAnswer({ ...final, sourceIds: [draft.requestId!] }, [market, draft], true, "Research ETH and draft a trade");
    expect(output.answer).toContain("Sources:");
    expect(output.answer).toContain(source.url);
  });
});
