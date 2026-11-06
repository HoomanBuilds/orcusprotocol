import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { parseSetupEnvironment, setupDemo, validMasterKey, validatePublicAppUrl } from "./demo-setup";

let root: string, envFile: string, dataDir: string, projectRoot: string;
const master = "ab".repeat(32), token = "test-only-token-".repeat(3);
const options = () => ({ envFile, dataDir, projectRoot, appUrl: "https://demo.example" });
const configured = () => `ORCUS_APP_URL=https://demo.example\nORCUS_DATA_DIR=${dataDir}\nORCUS_MASTER_KEY=${master}\nORCUS_INTERNAL_TOKEN=${token}\n`;
const writeEnv = (value: string) => writeFileSync(envFile, value, { mode: 0o600 });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orcus-demo-setup-"));
  projectRoot = join(root, "checkout"); mkdirSync(projectRoot, { mode: 0o700 });
  envFile = join(projectRoot, ".env"); dataDir = join(root, "runtime");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("demo runtime setup", () => {
  it("creates private runtime settings without returning secrets and is idempotent", () => {
    const result = setupDemo(options()), env = parseEnv(readFileSync(envFile, "utf8"));
    expect(env.ORCUS_MASTER_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(env.ORCUS_INTERNAL_TOKEN).toHaveLength(64);
    expect(env.ORCUS_INTERNAL_APP_URL).toBe("http://127.0.0.1:3000");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(result)).not.toContain(env.ORCUS_MASTER_KEY);
    const original = statSync(envFile);
    expect(setupDemo(options()).changed).toEqual([]);
    expect(statSync(envFile).ino).toBe(original.ino);
    expect(readdirSync(projectRoot)).toEqual([".env"]);
  });

  it("preserves existing credentials, comments, token and hex or base64 master key", () => {
    const encoded = Buffer.from(master, "hex").toString("base64");
    const content = `# Keep this comment\nPROVIDER_SECRET='unrelated value # intact'\n${configured().replace(master, encoded)}ORCUS_INTERNAL_APP_URL=https://worker.example\n`;
    writeEnv(content); chmodSync(envFile, 0o644);
    expect(setupDemo(options()).changed).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toBe(content);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("reuses the original owner-only local key when enabling hosted configuration", () => {
    mkdirSync(dataDir, { mode: 0o700 });
    writeFileSync(join(dataDir, "master.key"), Buffer.from(master, "hex"), { mode: 0o600 });
    writeFileSync(join(dataDir, "platform.sqlite"), "existing encrypted runtime", { mode: 0o600 });
    setupDemo(options());
    expect(parseEnv(readFileSync(envFile, "utf8")).ORCUS_MASTER_KEY).toBe(master);
    expect(readFileSync(join(dataDir, "master.key"))).toEqual(Buffer.from(master, "hex"));
  });

  it("refuses nonempty runtime without its original key", () => {
    mkdirSync(dataDir, { mode: 0o700 }); writeFileSync(join(dataDir, "platform.sqlite"), "existing runtime");
    expect(() => setupDemo(options())).toThrow(/original ORCUS_MASTER_KEY/);
    expect(existsSync(envFile)).toBe(false);
  });

  it("allows the configured original key with a nonempty runtime and no local key", () => {
    mkdirSync(dataDir, { mode: 0o700 }); writeFileSync(join(dataDir, "platform.sqlite"), "existing runtime");
    writeEnv(configured());
    setupDemo(options());
    expect(parseEnv(readFileSync(envFile, "utf8")).ORCUS_MASTER_KEY).toBe(master);
  });

  it.each(["hex", "base64"] as const)("accepts a matching configured and local master key: %s", encoding => {
    mkdirSync(dataDir, { mode: 0o700 });
    writeFileSync(join(dataDir, "master.key"), Buffer.from(master, "hex"), { mode: 0o600 });
    writeEnv(configured().replace(master, Buffer.from(master, "hex").toString(encoding)));
    setupDemo(options());
    expect(readFileSync(join(dataDir, "master.key"))).toEqual(Buffer.from(master, "hex"));
  });

  it.each([false, true])("refuses a configured/local key mismatch without changing either key, check mode: %s", check => {
    mkdirSync(dataDir, { mode: 0o700 });
    const local = Buffer.alloc(32, 1), keyPath = join(dataDir, "master.key");
    writeFileSync(keyPath, local, { mode: 0o600 }); writeEnv(configured());
    expect(() => setupDemo({ ...options(), check })).toThrow(/does not match/);
    expect(readFileSync(keyPath)).toEqual(local);
    expect(readFileSync(envFile, "utf8")).toBe(configured());
  });

  it.each(["short", "!".repeat(64)])("never replaces invalid configured master keys", value => {
    writeEnv(configured().replace(master, value));
    const original = readFileSync(envFile);
    expect(() => setupDemo(options())).toThrow(/ORCUS_MASTER_KEY/);
    expect(readFileSync(envFile)).toEqual(original);
  });

  it.each(["short", " ".repeat(40)])("never replaces a nonempty invalid internal token", value => {
    writeEnv(configured().replace(token, JSON.stringify(value)));
    expect(() => setupDemo(options())).toThrow(/ORCUS_INTERNAL_TOKEN/);
    expect(parseEnv(readFileSync(envFile, "utf8")).ORCUS_INTERNAL_TOKEN).toBe(value);
  });

  it.each(["public", "wrong-length"])("refuses unsafe existing local key files: %s", mode => {
    mkdirSync(dataDir, { mode: 0o700 });
    writeFileSync(join(dataDir, "master.key"), Buffer.alloc(mode === "wrong-length" ? 31 : 32), { mode: mode === "public" ? 0o644 : 0o600 });
    expect(() => setupDemo(options())).toThrow(/key/i);
    expect(existsSync(envFile)).toBe(false);
  });

  it("checks existing configuration without writes, locks or generated values", () => {
    writeEnv(configured()); mkdirSync(dataDir, { mode: 0o700 });
    const original = statSync(envFile);
    expect(setupDemo({ envFile, projectRoot, check: true })).toEqual({ changed: [], checked: true });
    expect(statSync(envFile).mtimeMs).toBe(original.mtimeMs);
    expect(readdirSync(projectRoot)).toEqual([".env"]);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("does not use desired flag values to pretend missing config passes check mode", () => {
    expect(() => setupDemo({ ...options(), check: true })).toThrow(/existing matching/);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(envFile)).toBe(false);
  });

  it("rejects concurrent setup without touching its lock", () => {
    writeFileSync(`${envFile}.setup.lock`, "other process", { mode: 0o600 });
    expect(() => setupDemo(options())).toThrow(/locked/);
    expect(readFileSync(`${envFile}.setup.lock`, "utf8")).toBe("other process");
  });

  it.each(["symlink", "hardlink"])("rejects an environment %s", kind => {
    const target = join(root, "credentials"); writeFileSync(target, configured(), { mode: 0o600 });
    if (kind === "symlink") symlinkSync(target, envFile); else linkSync(target, envFile);
    expect(() => setupDemo(options())).toThrow(/symbolic link|extra links/);
    expect(readFileSync(target, "utf8")).toBe(configured());
  });

  it.each([false, true])("rejects runtime symlinks including dangling links: %s", dangling => {
    const target = join(root, "elsewhere");
    if (!dangling) mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, dataDir);
    expect(() => setupDemo(options())).toThrow(/symbolic links/);
    expect(lstatSync(dataDir).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked environment ancestor", () => {
    const alias = join(root, "alias"); symlinkSync(projectRoot, alias);
    expect(() => setupDemo({ ...options(), envFile: join(alias, ".env") })).toThrow(/symbolic links/);
  });

  it("rejects public runtime permissions and runtime paths in the checkout", () => {
    mkdirSync(dataDir, { mode: 0o755 });
    expect(() => setupDemo(options())).toThrow(/owner-only/);
    expect(() => setupDemo({ ...options(), dataDir: join(projectRoot, "runtime") })).toThrow(/outside/);
    expect(() => setupDemo({ ...options(), dataDir: "/" })).toThrow(/filesystem root/);
    expect(() => setupDemo({ ...options(), dataDir: "relative" })).toThrow(/absolute/);
  });

  it("refuses an implicit runtime migration", () => {
    writeEnv(configured());
    expect(() => setupDemo({ ...options(), dataDir: join(root, "new-runtime") })).toThrow(/Migrate runtime data/);
    expect(readFileSync(envFile, "utf8")).toBe(configured());
  });

  it("changes an explicit public or private origin without changing existing credentials", () => {
    writeEnv(configured());
    setupDemo({ ...options(), appUrl: "https://new.example/", internalAppUrl: "http://127.0.0.1:4000" });
    expect(parseEnv(readFileSync(envFile, "utf8"))).toMatchObject({ ORCUS_APP_URL: "https://new.example", ORCUS_INTERNAL_APP_URL: "http://127.0.0.1:4000", ORCUS_MASTER_KEY: master, ORCUS_INTERNAL_TOKEN: token });
  });
});

describe("runtime input validation", () => {
  it.each(["http://demo.example", "https://user:secret@demo.example", "https://demo.example/path", "https://demo.example?token=x", "https://demo.example#fragment", " https://demo.example", "javascript:alert(1)"])("rejects unsuitable public origins", value => {
    expect(() => validatePublicAppUrl(value)).toThrow(/ORCUS_APP_URL/);
  });
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://demo.example"])("accepts HTTPS or loopback development origins", value => {
    expect(validatePublicAppUrl(value)).toBe(value);
  });
  it("rejects duplicate owned assignments rather than changing which secret is used", () => {
    expect(() => parseSetupEnvironment(`ORCUS_MASTER_KEY=${master}\nexport ORCUS_MASTER_KEY=${master}\n`)).toThrow(/duplicate/);
    expect(() => parseSetupEnvironment(`ORCUS_MASTER_KEY=${master}\n  ORCUS_MASTER_KEY=${master}\n`)).toThrow(/duplicate/);
  });
  it("validates canonical base64 and exact hex key lengths", () => {
    expect(validMasterKey(master)).toBe(true);
    expect(validMasterKey(Buffer.alloc(32).toString("base64"))).toBe(true);
    expect(validMasterKey(Buffer.alloc(32).toString("base64").replace(/=$/, ""))).toBe(true);
    expect(validMasterKey("x".repeat(64))).toBe(false);
    expect(validMasterKey(Buffer.alloc(31).toString("base64"))).toBe(false);
    expect(validMasterKey(Buffer.alloc(33).toString("base64"))).toBe(false);
  });
});
