import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { parseEnv } from "node:util";

type SetupOptions = { envFile: string; projectRoot: string; appUrl?: string; dataDir?: string; internalAppUrl?: string; check?: boolean };
const runtimeNames = ["ORCUS_APP_URL", "ORCUS_DATA_DIR", "ORCUS_INTERNAL_APP_URL", "ORCUS_MASTER_KEY", "ORCUS_INTERNAL_TOKEN"] as const;

export function validatePublicAppUrl(value: string) {
  const url = validateOrigin(value, "ORCUS_APP_URL");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("ORCUS_APP_URL must use HTTPS except for a loopback development origin.");
  return url.origin;
}

export function validateOrigin(value: string, name: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) origin.`); }
  if (value !== value.trim() || /[\s\u0000-\u001f\u007f]/.test(value) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query or fragment.`);
  return url;
}

export function validMasterKey(value: string) {
  return /^[\da-fA-F]{64}$/.test(value) || /^[A-Za-z0-9+/]{43}=?$/.test(value) && Buffer.from(value, "base64").toString("base64").replace(/=$/, "") === value.replace(/=$/, "");
}

export function validateDataDir(value: string, projectRoot: string) {
  if (!isAbsolute(value) || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("ORCUS_DATA_DIR must be an absolute private runtime directory.");
  const directory = resolve(value), checkout = resolve(projectRoot);
  if (directory === parse(directory).root || directory === checkout || directory.startsWith(checkout + sep)) throw new Error("ORCUS_DATA_DIR must be outside the checkout and cannot be the filesystem root.");
  return directory;
}

function safeAncestors(path: string) {
  let current = resolve(path);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Setup paths cannot contain symbolic links or non-directories.");
      if ((stat.mode & 0o022) && !(stat.mode & 0o1000)) throw new Error("Setup paths cannot have group- or world-writable parent directories.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ownerOnly(stat: Stats, label: string) {
  if (process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error(`${label} must be owned by the current user with owner-only permissions.`);
}

function readOwnedFile(path: string, privateMode: boolean) {
  let file: number;
  try { file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Setup input must be a regular file, not a symbolic link."); }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error("Setup input must be a current-user-owned regular file without extra links or group/world write access.");
    if (privateMode) ownerOnly(stat, "Master key file");
    return { stat, content: readFileSync(file) };
  } finally { closeSync(file); }
}

export function parseSetupEnvironment(content: string) {
  for (const name of runtimeNames) {
    if ((content.match(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=`, "gm")) ?? []).length > 1) throw new Error(`Remove duplicate ${name} assignments before setup.`);
  }
  try { return parseEnv(content); } catch { throw new Error("The environment file could not be parsed. No settings were changed."); }
}

function replaceSetting(content: string, name: string, value: string) {
  const line = `${name}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "m");
  return pattern.test(content) ? content.replace(pattern, () => line) : `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
}

function sameSnapshot(left: ReturnType<typeof readOwnedFile>, right: ReturnType<typeof readOwnedFile>) {
  return left === undefined ? right === undefined : right !== undefined && left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino && left.stat.mtimeMs === right.stat.mtimeMs && left.stat.ctimeMs === right.stat.ctimeMs && left.content.equals(right.content);
}

export function setupDemo(options: SetupOptions) {
  const envFile = resolve(options.envFile), parent = dirname(envFile);
  safeAncestors(parent);
  if (!existsSync(parent)) throw new Error("The environment file's parent directory must already exist.");
  const lockPath = `${envFile}.setup.lock`;
  let lock: number | undefined;
  if (!options.check) {
    try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error("Setup is already locked. Stop concurrent setup and inspect the lock before retrying."); }
  }
  let temporary: string | undefined;
  try {
    const original = readOwnedFile(envFile, false), content = original?.content.toString("utf8") ?? "", env = parseSetupEnvironment(content);
    const values = { ...env };
    values.ORCUS_APP_URL = validatePublicAppUrl(options.appUrl ?? env.ORCUS_APP_URL ?? "");
    values.ORCUS_DATA_DIR = validateDataDir(options.dataDir ?? env.ORCUS_DATA_DIR ?? "", options.projectRoot);
    if (env.ORCUS_DATA_DIR && resolve(env.ORCUS_DATA_DIR) !== values.ORCUS_DATA_DIR) throw new Error("Setup cannot change an existing ORCUS_DATA_DIR. Migrate runtime data explicitly before editing that setting.");
    values.ORCUS_INTERNAL_APP_URL = validateOrigin(options.internalAppUrl ?? (env.ORCUS_INTERNAL_APP_URL || "http://127.0.0.1:3000"), "ORCUS_INTERNAL_APP_URL").origin;
    if (options.check && (values.ORCUS_APP_URL !== env.ORCUS_APP_URL?.replace(/\/$/, "") || values.ORCUS_DATA_DIR !== env.ORCUS_DATA_DIR || options.internalAppUrl && values.ORCUS_INTERNAL_APP_URL !== env.ORCUS_INTERNAL_APP_URL)) throw new Error("Check mode requires existing matching runtime settings. Run demo:setup without --check to apply settings.");
    const directory = values.ORCUS_DATA_DIR;
    safeAncestors(directory);
    if (existsSync(directory)) ownerOnly(lstatSync(directory), "Runtime directory");
    else if (options.check) throw new Error("The private runtime directory is missing. Run demo:setup first.");
    const keyPath = join(directory, "master.key"), localKey = readOwnedFile(keyPath, true);
    if (localKey && localKey.content.length !== 32) throw new Error("The existing master.key must contain exactly 32 bytes. Restore the original key; setup will not replace it.");
    if (env.ORCUS_MASTER_KEY) {
      if (!validMasterKey(env.ORCUS_MASTER_KEY)) throw new Error("ORCUS_MASTER_KEY must encode exactly 32 bytes as hex or base64. Restore the original key; setup will not replace it.");
      const configuredKey = Buffer.from(env.ORCUS_MASTER_KEY, /^[\da-fA-F]{64}$/.test(env.ORCUS_MASTER_KEY) ? "hex" : "base64");
      try {
        if (localKey && !configuredKey.equals(localKey.content)) throw new Error("ORCUS_MASTER_KEY does not match the existing master.key. Restore the original runtime configuration; setup will not change either key.");
      } finally { configuredKey.fill(0); }
    } else {
      if (options.check) throw new Error("ORCUS_MASTER_KEY is missing. Run demo:setup using the original runtime key.");
      if (!localKey && existsSync(directory) && readdirSync(directory).length) throw new Error("The runtime directory is nonempty but its master key is missing. Configure the original ORCUS_MASTER_KEY; setup will not generate a replacement.");
      values.ORCUS_MASTER_KEY = localKey ? localKey.content.toString("hex") : randomBytes(32).toString("hex");
    }
    if (env.ORCUS_INTERNAL_TOKEN) {
      if (env.ORCUS_INTERNAL_TOKEN.length < 32 || /\s/.test(env.ORCUS_INTERNAL_TOKEN)) throw new Error("ORCUS_INTERNAL_TOKEN must contain at least 32 non-whitespace characters. Setup will not replace an existing token.");
    } else {
      if (options.check) throw new Error("ORCUS_INTERNAL_TOKEN is missing. Run demo:setup first.");
      values.ORCUS_INTERNAL_TOKEN = randomBytes(32).toString("hex");
    }
    if (options.check) {
      if (original) ownerOnly(original.stat, "Environment file");
      return { changed: [] as string[], checked: true };
    }
    let next = content;
    const changed = runtimeNames.filter(name => values[name] !== env[name]);
    for (const name of changed) next = replaceSetting(next, name, values[name]!);
    const saved = parseSetupEnvironment(next);
    if (runtimeNames.some(name => saved[name] !== values[name])) throw new Error("Runtime settings could not be represented safely in the environment file. No settings were changed.");
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    safeAncestors(directory);
    ownerOnly(lstatSync(directory), "Runtime directory");
    if (changed.length || original && (original.stat.mode & 0o077)) {
      temporary = join(parent, `.${parse(envFile).base}.${randomBytes(12).toString("hex")}.tmp`);
      const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(file, next); fsyncSync(file); } finally { closeSync(file); }
      if (!sameSnapshot(localKey, readOwnedFile(keyPath, true)) || !env.ORCUS_MASTER_KEY && !localKey && readdirSync(directory).length) throw new Error("Runtime data changed during setup. Stop web and worker processes before retrying.");
      safeAncestors(parent);
      if (!sameSnapshot(original, readOwnedFile(envFile, false))) throw new Error("The environment file changed during setup. No settings were overwritten; retry after stopping other edits.");
      if (original) renameSync(temporary, envFile);
      else { linkSync(temporary, envFile); unlinkSync(temporary); }
      temporary = undefined;
      const folder = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(folder); } finally { closeSync(folder); }
    }
    return { changed, checked: false };
  } finally {
    if (temporary) unlinkSync(temporary);
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}
