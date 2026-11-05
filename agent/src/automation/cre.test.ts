import { afterEach, describe, expect, it, vi } from "vitest";
import { creChildEnvironment, parseCreOutput } from "./cre";

afterEach(() => vi.unstubAllEnvs());

describe("CRE runner trust boundary", () => {
  it("keeps signing and compute secrets outside the CLI child", () => {
    vi.stubEnv("ORCUS_MASTER_KEY", "must-not-inherit");
    vi.stubEnv("ZEROG_COMPUTE_API_KEY", "must-not-inherit");
    vi.stubEnv("CRE_API_KEY", "allowed-cli-auth");
    const env = creChildEnvironment();
    expect(env.ORCUS_MASTER_KEY).toBeUndefined();
    expect(env.ZEROG_COMPUTE_API_KEY).toBeUndefined();
    expect(env.CRE_API_KEY).toBe("allowed-cli-auth");
  });
  it("parses structured local output and rejects missing or hosted evidence", () => {
    const output = { evaluationId: "evaluation", automationId: "job", accountId: "account", chainId: 11155111, decision: "allow", reason: "condition met", source: "local-simulation", observedAt: 1, expiresAt: 2, controlRevision: 1, policyVersion: 1 };
    expect(parseCreOutput(`runner: ORCUS_CRE_RESULT=${JSON.stringify(output)}`).decision).toBe("allow");
    expect(() => parseCreOutput("no workflow result")).toThrow("no authenticated evaluation");
    expect(() => parseCreOutput(`ORCUS_CRE_RESULT=${JSON.stringify({ ...output, source: "hosted" })}`)).toThrow("malformed or unsupported");
  });
  it("normalizes an absent preset-strategy inference ID before backend binding", () => {
    const output = { evaluationId: "evaluation", automationId: "job", accountId: "account", chainId: 11155111, decision: "allow", reason: "condition met", source: "local-simulation", observedAt: 1, expiresAt: 2, controlRevision: 1, policyVersion: 1 };
    const parse = (requestId?: string) => parseCreOutput(`ORCUS_CRE_RESULT=${JSON.stringify({ ...output, requestId })}`);
    expect(parse().requestId).toBeUndefined();
    expect(parse("").requestId).toBeUndefined();
    expect(parse("real-provider-request").requestId).toBe("real-provider-request");
  });
});
