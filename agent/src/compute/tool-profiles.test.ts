import { describe, expect, it, vi } from "vitest";
import { buildAgentTools } from "./tools";
import { invokeProfileTool, resolveToolProfile, selectProfileTools } from "./tool-profiles";

describe("agent tool profiles", () => {
  it("keeps interactive tools by default and exposes only reads and typed trades to strategies", () => {
    expect([...buildAgentTools({}, "Research ETH.").keys()]).toEqual(["read_markets", "read_portfolio", "analyze_market", "search_memory", "remember_preference", "forget_memory", "propose_action", "propose_automation"]);
    expect([...buildAgentTools({ toolProfile: "strategy" }, "Research ETH.").keys()]).toEqual(["read_markets", "read_portfolio", "analyze_market", "search_memory", "propose_action"]);
  });

  it.each(["", "full", "constructor", "toString", null, false, {}])("rejects unknown profiles without falling back: %j", profile => {
    expect(() => resolveToolProfile(profile)).toThrow(expect.objectContaining({ code: "INVALID_TOOL_PROFILE" }));
  });

  it.each(["remember_preference", "forget_memory", "propose_automation", "sign_transaction", "transfer", "unknown_tool"])("refuses invocation of a hidden or arbitrary tool: %s", async name => {
    const run = vi.fn(async () => ({ changed: true }));
    await expect(invokeProfileTool("strategy", new Map([[name, { name, run }]]), name, {})).rejects.toMatchObject({ code: "TOOL_PROFILE_DENIED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses missing definitions and renamed handlers instead of weakening the profile", async () => {
    expect(() => selectProfileTools(new Map(), "strategy")).toThrow(expect.objectContaining({ code: "TOOL_PROFILE_MISCONFIGURED" }));
    const registry = new Map([...buildAgentTools({ toolProfile: "strategy" }, "Research ETH.")]);
    const scoped = selectProfileTools(registry, "strategy");
    const run = vi.fn(async () => ({}));
    registry.set("read_markets", { name: "remember_preference", description: "", arguments: "{}", run });
    await expect(scoped.get("read_markets")!.run({})).rejects.toMatchObject({ code: "TOOL_PROFILE_MISCONFIGURED" });
    expect(run).not.toHaveBeenCalled();
  });
});
