import { describe, expect, it } from "vitest";
import { groundFinalAnswer } from "./grounding";
import type { ToolTrace } from "./types";

const source = { id: "5530e9cd41830cc3", title: "Hyperliquid testnet market observations", url: "https://api.hyperliquid-testnet.xyz/info", retrievedAt: 1794026329484, network: "testnet" };
const observationId = "observation:5bc3ac0644af6d6fc4c2c6c6";
const trace: ToolTrace = { name: "read_markets", observationId, requestId: "billing-request", ok: true, observedAt: source.retrievedAt, arguments: { venue: "hyperliquid", symbols: ["ETH"] }, result: { markets: [{ symbol: "ETH", midPrice: "2253.5" }], sources: [source] } };
const answer = { message: "ETH on Hyperliquid testnet is at $2,253.50 (mid-price).", basis: "observed" as const, requiresClarification: false, sourceIds: [source.id], observationIds: [observationId] };

describe("research observation citations", () => {
  it("accepts the successful market observation after a failed tool attempt", () => {
    const failed = { ...trace, observationId: "observation:failed", ok: false, result: { error: "Expected symbols array" } };
    const result = groundFinalAnswer(answer, [failed, trace], false, "Read ETH on Hyperliquid testnet.");
    expect(result).toMatchObject({ requiresClarification: false, clearProposal: false });
    expect(result.answer).toContain(answer.message);
    expect(result.answer).toContain(source.url);
  });

  it.each(["unknown", "billing-request", ""])("rejects invalid observation reference %j", id => {
    expect(groundFinalAnswer({ ...answer, observationIds: [id] }, [trace], false)).toMatchObject({ requiresClarification: true, clearProposal: true });
  });

  it.each([
    { ...trace, ok: false },
    { ...trace, name: "unregistered_tool" },
    { ...trace, result: { sources: [] } },
    { ...trace, result: { sources: [{ ...source, url: "http://localhost/private" }] } },
  ])("rejects failed, unsupported or source-less observations", invalid => {
    const other = { ...trace, observationId: "observation:other" };
    expect(groundFinalAnswer(answer, [other, invalid], false)).toMatchObject({ requiresClarification: true, clearProposal: true });
  });

  it.each([true, false])("rejects duplicate observation IDs even when duplicate success is %j", ok => {
    expect(groundFinalAnswer(answer, [trace, { ...trace, ok }], false)).toMatchObject({ requiresClarification: true, clearProposal: true });
  });

  it("rejects a collision between research and memory observations", () => {
    const memory = { ...trace, name: "remember_preference", result: { id: "note:1", content: "No leverage" } };
    expect(groundFinalAnswer(answer, [trace, memory], false)).toMatchObject({ requiresClarification: true, clearProposal: true });
  });

  it("does not promote billing IDs to public sources or allow fabricated links", () => {
    expect(groundFinalAnswer({ ...answer, sourceIds: [trace.requestId!] }, [trace], false).requiresClarification).toBe(true);
    expect(groundFinalAnswer({ ...answer, message: "See https://fake.example/report" }, [trace], false).requiresClarification).toBe(true);
  });
});
