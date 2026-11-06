import { EngineError } from "../errors";

const readTools = ["read_markets", "read_portfolio", "analyze_market", "read_market_context", "search_memory"] as const;
const profileTools = {
  interactive: [...readTools, "search_research", "remember_preference", "forget_memory", "propose_action", "propose_automation"],
  strategy: [...readTools, "propose_action"],
} as const;

export type AgentToolProfile = keyof typeof profileTools;
type Tool = { name: string; run(input: unknown): Promise<unknown> };

export function resolveToolProfile(profile: unknown): AgentToolProfile {
  if (profile === undefined) return "interactive";
  if (typeof profile !== "string" || !Object.hasOwn(profileTools, profile)) throw new EngineError("INVALID_TOOL_PROFILE", "The agent tool profile is unknown. No tools or inference were enabled.", 403);
  return profile as AgentToolProfile;
}

export function assertProfileTool(profile: AgentToolProfile, name: string) {
  const allowed: readonly string[] = profileTools[resolveToolProfile(profile)];
  if (!allowed.includes(name)) throw new EngineError("TOOL_PROFILE_DENIED", `The ${profile} agent profile cannot use ${name}.`, 403);
}

export async function invokeProfileTool<T extends Tool>(profile: AgentToolProfile, tools: ReadonlyMap<string, T>, name: string, input: unknown) {
  assertProfileTool(profile, name);
  const tool = tools.get(name);
  if (!tool || tool.name !== name) throw new EngineError("TOOL_PROFILE_MISCONFIGURED", "A permitted agent tool is not registered correctly. No tool was invoked.", 503);
  return tool.run(input);
}

export function selectProfileTools<T extends Tool>(registry: ReadonlyMap<string, T>, profile: AgentToolProfile): Map<string, T> {
  return new Map(profileTools[resolveToolProfile(profile)].map(name => {
    const tool = registry.get(name);
    if (!tool || tool.name !== name) throw new EngineError("TOOL_PROFILE_MISCONFIGURED", "A tool profile names an unregistered agent tool. No tools were enabled.", 503);
    return [name, { ...tool, run: (input: unknown) => invokeProfileTool(profile, registry, name, input) }];
  }));
}
