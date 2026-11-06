import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCre, localResultLine } from "./check-cre.mjs";

const result = 'ORCUS_CRE_LOCAL_RESULT={"mode":"local-simulation","currentPrice":"2222.8","previousPrice":"1","changed":true,"wouldWrite":false}';
const settings = ["CRE_API_KEY", "CRE_CLI_PATH", "ORCUS_MASTER_KEY", "ORCUS_INTERNAL_TOKEN", "ZEROG_COMPUTE_API_KEY", "NODE_OPTIONS"];
let directory: string;

beforeEach(() => {
  for (const name of settings) vi.stubEnv(name, undefined);
  directory = mkdtempSync(join(tmpdir(), "orcus-cre-check-test-"));
  mkdirSync(join(directory, "workflows", "cre"), { recursive: true });
  writeFileSync(join(directory, ".env"), "CRE_API_KEY='synthetic-$(not-a-shell-command)'\nCRE_CLI_PATH=/test/cre\nORCUS_MASTER_KEY=synthetic-master\nORCUS_INTERNAL_TOKEN=synthetic-token\nZEROG_COMPUTE_API_KEY=synthetic-inference\nNODE_OPTIONS=synthetic-node-options\n", { mode: 0o600 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("credential-safe CRE host check", () => {
  it("loads root dotenv opaquely, allows only CRE child settings and uses fixed non-broadcast commands", () => {
    let privateDirectory = "";
    const run = vi.fn((cli, args, options) => {
      expect(cli).toBe("/test/cre");
      expect(options.cwd).toBe(join(directory, "workflows", "cre"));
      expect(options.env.CRE_API_KEY).toBe("synthetic-$(not-a-shell-command)");
      for (const name of settings.slice(2)) expect(options.env).not.toHaveProperty(name);
      expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(options.maxBuffer).toBe(1_000_000);
      const envPath = args[args.indexOf("--env") + 1];
      const publicEnvPath = args[args.indexOf("--public-env") + 1];
      privateDirectory = join(envPath, "..");
      for (const path of [envPath, publicEnvPath]) {
        expect(readFileSync(path, "utf8")).toBe("");
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      return args[0] === "whoami" ? "Synthetic private identity not for stdout" : `other private CLI output\n[USER LOG] ${result}\n`;
    });
    expect(checkCre(directory, run)).toBe(result);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1][0]).toBe("whoami");
    expect(run.mock.calls[0][2].timeout).toBe(10_000);
    expect(run.mock.calls[1][1].slice(0, 7)).toEqual(["workflow", "simulate", "strategy", "--target", "local-simulation", "--trigger-index", "0"]);
    expect(run.mock.calls[1][1]).not.toContain("--broadcast");
    expect(run.mock.calls[1][2].timeout).toBe(90_000);
    expect(existsSync(privateDirectory)).toBe(false);
  });

  it("supports the service user's existing browser login without an API key", () => {
    writeFileSync(join(directory, ".env"), "CRE_CLI_PATH=/test/cre\n");
    const run = vi.fn((_cli, args, options) => {
      expect(options.env).not.toHaveProperty("CRE_API_KEY");
      return args[0] === "whoami" ? "Synthetic private identity" : result;
    });
    expect(checkCre(directory, run)).toBe(result);
  });

  it("fails before launching a CLI when root dotenv is missing", () => {
    rmSync(join(directory, ".env"));
    const run = vi.fn();
    expect(() => checkCre(directory, run)).toThrow("configuration check failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("withholds authentication errors and never starts simulation after failure", () => {
    const run = vi.fn(() => { throw new Error("synthetic-secret-in-cli-error"); });
    expect(() => checkCre(directory, run)).toThrow("CRE authentication check failed. Raw CLI diagnostics were withheld.");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("withholds failed simulation output", () => {
    const run = vi.fn().mockReturnValueOnce("private identity").mockImplementationOnce(() => { throw new Error("synthetic-secret-in-cli-error"); });
    expect(() => checkCre(directory, run)).toThrow("CRE local simulation check failed. Raw CLI diagnostics were withheld.");
  });
});

describe("local simulation result disclosure", () => {
  it("returns only one actual bounded result line, without CLI metadata", () => {
    expect(localResultLine(`private metadata\n\u001b[32m[USER LOG] ${result}\u001b[0m\nprivate metadata`)).toBe(result);
  });

  it.each(["", `${result}\n${result}`, "ORCUS_CRE_LOCAL_RESULT=not-json", result.replace('"wouldWrite":false', '"wouldWrite":true'), result.replace('"2222.8"', '"synthetic-secret"'), result.replace('"currentPrice":"2222.8"', '"currentPrice":"synthetic-secret","currentPrice":"2222.8"'), result.replace('"changed":true', '"changed":true,"extra":"synthetic-secret"'), `ORCUS_CRE_LOCAL_RESULT=${" ".repeat(1025)}{}`])("rejects missing, ambiguous, unsafe or oversized output", (stdout) => {
    expect(() => localResultLine(stdout)).toThrow();
  });
});
