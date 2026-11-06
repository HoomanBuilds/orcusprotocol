import { afterEach, describe, expect, it, vi } from "vitest";
import { creChildEnvironment, creRunFailure, parseCreOutput, withCreRunner } from "./cre";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
  it("serializes shared workflow builds and rejects excess queued evaluations", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const events: string[] = [], expiresAt = Date.now() + 60_000;
    const first = withCreRunner("shared-workflow", expiresAt, async () => { events.push("first"); await gate; return "first-result"; });
    const second = withCreRunner("shared-workflow", expiresAt, async () => { events.push("second"); return "second-result"; });
    await expect(withCreRunner("shared-workflow", expiresAt, async () => "never")).rejects.toMatchObject({ code: "CRE_RUNNER_BUSY" });
    expect(events).toEqual(["first"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["first-result", "second-result"]);
    expect(events).toEqual(["first", "second"]);
    await expect(withCreRunner("shared-workflow", expiresAt, async () => "released")).resolves.toBe("released");
  });
  it("rechecks expiry after waiting without starting the stale operation", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), operation = vi.fn(async () => "must-not-run");
    const first = withCreRunner("expiring-workflow", 5_000, () => gate);
    const second = withCreRunner("expiring-workflow", 1_500, operation);
    const rejected = expect(second).rejects.toMatchObject({ code: "STALE_EVALUATION" });
    clock.mockReturnValue(2_000);
    release();
    await Promise.all([first, rejected]);
    expect(operation).not.toHaveBeenCalled();
    await expect(withCreRunner("expiring-workflow", 5_000, async () => "released")).resolves.toBe("released");
  });
  it("releases a failed build and keeps independent workflow directories unblocked", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), expiresAt = Date.now() + 60_000;
    const first = withCreRunner("failing-workflow", expiresAt, async () => { await gate; throw new Error("failed build"); });
    const rejected = expect(first).rejects.toThrow("failed build");
    const second = withCreRunner("failing-workflow", expiresAt, async () => "next-result");
    await expect(withCreRunner("other-workflow", expiresAt, async () => "independent")).resolves.toBe("independent");
    release();
    await rejected;
    await expect(second).resolves.toBe("next-result");
  });
  it.each([
    [{ code: "ENOENT" }, "CRE_CLI_UNAVAILABLE"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "CRE_OUTPUT_LIMIT"],
    [{ killed: true }, "CRE_RUN_TIMEOUT"],
    [{ stderr: "authentication required secret-value" }, "CRE_AUTH_REQUIRED"],
    [{ stdout: "failed to compile: cannot find .cre_build_tmp.js secret-value" }, "CRE_BUILD_CONFLICT"],
    [{ stderr: "compilation failed secret-value" }, "CRE_BUILD_FAILED"],
    [{ stderr: "unrecognized upstream failure secret-value" }, "CRE_RUN_FAILED"],
    [null, "CRE_RUN_FAILED"],
  ])("classifies CLI failure without exposing raw logs: %s", (error, code) => {
    const failure = creRunFailure(error);
    expect(failure.code).toBe(code);
    expect(failure.message).not.toContain("secret-value");
  });
});
