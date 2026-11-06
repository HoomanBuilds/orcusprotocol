import { describe, expect, it, vi } from "vitest";
import { safeAgentToolSteps } from "./agent-evidence";

const step = { name: "read_markets", ok: true, observedAt: 1_783_000_000_000, requestId: "e67d6832-864f-4ab7-8f1b-a5514b7c466e" };

describe("safe public agent evidence", () => {
  it("copies only registered tool names, real outcomes, epoch timestamps, and bounded request identifiers", () => {
    const trace = [{ ...step, arguments: { rawPrompt: "private prompt" }, result: { signature: "private signature", key: "private key" }, other: "private" }];
    expect(safeAgentToolSteps(trace)).toEqual([step]);
    expect(safeAgentToolSteps(trace)[0]).not.toBe(trace[0]);
    expect(Object.keys(safeAgentToolSteps(trace)[0]!)).toEqual(["name", "ok", "observedAt", "requestId"]);
  });

  it.each(["read_markets", "read_portfolio", "analyze_market", "search_memory", "remember_preference", "forget_memory", "propose_action", "propose_automation"]) ("allows the registered %s tool without implying execution authority", name => {
    expect(safeAgentToolSteps([{ ...step, name, ok: false }])).toEqual([{ ...step, name, ok: false }]);
  });

  it.each([null, undefined, {}, "trace", 1, true, { toolTrace: [step] }])("ignores non-array engine output", input => {
    expect(safeAgentToolSteps(input)).toEqual([]);
  });

  it.each([null, "step", [], {}, { ...step, name: "transfer_funds" }, { ...step, name: "constructor" }, { ...step, name: "READ_MARKETS" }, { ...step, name: "read_markets\nprompt" }, { ...step, name: "read_markets".repeat(1000) }, { ...step, ok: "true" }, { ...step, ok: 1 }, { ...step, observedAt: "1783000000000" }, { ...step, observedAt: null }, { ...step, observedAt: NaN }, { ...step, observedAt: Infinity }, { ...step, observedAt: Number.MAX_VALUE }, { ...step, observedAt: 0 }, { ...step, observedAt: -1 }, { ...step, observedAt: 1.5 }])("drops entries with invalid names, outcomes, or timestamps", input => {
    expect(safeAgentToolSteps([input])).toEqual([]);
  });

  it.each([undefined, null, 123, {}, "", "x".repeat(201), "private prompt with spaces", "request\nsecret", "sk-not-a-real-key", "mk_not-a-real-key", "pk_not-a-real-key", `0x${"a".repeat(130)}`, "aaaaaaaa.bbbbbbbb.cccccccc"]) ("omits invalid or credential-shaped request IDs without losing valid tool outcomes", requestId => {
    expect(safeAgentToolSteps([{ ...step, requestId }])).toEqual([{ name: step.name, ok: step.ok, observedAt: step.observedAt }]);
  });

  it("accepts the bounded request ID limit without truncating or manufacturing an identifier", () => {
    const requestId = `request:${"x".repeat(192)}`;
    expect(requestId).toHaveLength(200);
    expect(safeAgentToolSteps([{ ...step, requestId }])[0]?.requestId).toBe(requestId);
  });

  it("never touches arguments, results, prompts, signatures, serialization hooks, or inherited fields", () => {
    const leaked = vi.fn(() => { throw new Error("A private field was evaluated"); });
    const entry = Object.assign(Object.create({ inheritedSecret: "not public" }), step);
    for (const key of ["arguments", "result", "prompt", "signature", "toJSON"]) Object.defineProperty(entry, key, { get: leaked });
    expect(safeAgentToolSteps([entry])).toEqual([step]);
    expect(leaked).not.toHaveBeenCalled();
    expect(safeAgentToolSteps([Object.create(step)])).toEqual([]);
  });

  it("does not invoke accessor fields or array index getters", () => {
    const read = vi.fn(() => step);
    const trace: unknown[] = [];
    Object.defineProperty(trace, "0", { get: read });
    const entry = { ...step }; Object.defineProperty(entry, "name", { get: read });
    expect(safeAgentToolSteps(trace)).toEqual([]);
    expect(safeAgentToolSteps([entry])).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("emits at most ten valid compact steps and bounds traversal of hostile oversized traces", () => {
    expect(safeAgentToolSteps(Array.from({ length: 1000 }, (_, index) => ({ ...step, observedAt: step.observedAt + index })))).toHaveLength(10);
    const invalid = Array.from({ length: 100 }, () => ({}));
    expect(safeAgentToolSteps([...invalid, step])).toEqual([]);
    expect(safeAgentToolSteps([{}, ...Array.from({ length: 12 }, () => step)])).toHaveLength(10);
  });

  it("returns no evidence for revoked or throwing proxy objects", () => {
    const proxy = Proxy.revocable([], {}); proxy.revoke();
    expect(safeAgentToolSteps(proxy.proxy)).toEqual([]);
    expect(safeAgentToolSteps([new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("untrusted descriptor"); } })])).toEqual([]);
  });
});
