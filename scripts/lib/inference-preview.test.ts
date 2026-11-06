import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inferencePreviewEnvironment } from "./inference-preview.mjs";

const runtime = { ORCUS_APP_URL: "http://localhost:3132", ORCUS_INTERNAL_APP_URL: "http://localhost:3132", ORCUS_DATA_DIR: "/tmp/evaluation-runtime", ORCUS_MASTER_KEY: "fixture-master", ORCUS_INTERNAL_TOKEN: "fixture-internal" };
const source = { ZEROG_COMPUTE_API_KEY: "fixture-inference", ZEROG_COMPUTE_MODEL: "fixture-model", ZEROG_COMPUTE_CHAT_URL: "https://example.test/chat/completions" };
describe("isolated inference preview environment", () => {
  it("launches from the checkout so external runtime data is not mistaken for project data", () => {
    const launcher = readFileSync(new URL("../start-inference-preview.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("cwd: root, env: environment");
    expect(launcher).toContain('"start", resolve(root, "web")');
    expect(launcher).not.toContain("dirname(resolve(runtimePath))");
  });
  it("allows only inference credentials and isolated runtime configuration", () => {
    const result = inferencePreviewEnvironment({ ...source, ZEROG_STORAGE_SPONSOR_PRIVATE_KEY: "forbidden", ZEROG_COMPUTE_MANAGEMENT_KEY: "forbidden", BRAVE_SEARCH_API_KEY: "forbidden", ORCUS_MASTER_KEY: "wrong", CRE_ENABLED: "true" }, runtime, { PATH: "/bin", NODE_OPTIONS: "--require forbidden", PRIVATE_KEY: "forbidden" });
    expect(result).toMatchObject({ ...runtime, ...source, PATH: "/bin", ORCUS_COMPUTE_PROJECT_DAILY_USD: "0.05", ORCUS_COMPUTE_USER_DAILY_USD: "0.05", CRE_ENABLED: "false", ZEROG_STORAGE_ENABLED: "false" });
    expect(Object.values(result)).not.toContain("forbidden");
    expect(result.NODE_OPTIONS).toBe("--max-old-space-size=1024");
    expect(result.ZEROG_COMPUTE_MANAGEMENT_KEY).toBeUndefined();
  });
  it("rejects unisolated origins, missing secrets and missing inference configuration", () => {
    for (const patch of [{ ORCUS_APP_URL: "https://example.test" }, { ORCUS_INTERNAL_APP_URL: "http://localhost:3000" }, { ORCUS_MASTER_KEY: "" }, { ORCUS_DATA_DIR: "relative" }]) expect(() => inferencePreviewEnvironment(source, { ...runtime, ...patch })).toThrow();
    expect(() => inferencePreviewEnvironment({}, runtime)).toThrow("inference key");
  });
});
