import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { User } from "@orcus/core";
import { ApiError } from "./errors";
import type { StoredRecord } from "./types";

const schema = `
CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,address TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,address TEXT NOT NULL,message TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,account_id TEXT,body TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_scope ON records(user_id,kind,created_at);
CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,address TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leases(scope TEXT PRIMARY KEY,holder TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS budgets(user_id TEXT PRIMARY KEY REFERENCES users(id),cap_micros INTEGER NOT NULL DEFAULT 0,spent_micros INTEGER NOT NULL DEFAULT 0,reserved_micros INTEGER NOT NULL DEFAULT 0,low_micros INTEGER NOT NULL DEFAULT 100000,auto_replenish INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),reference TEXT NOT NULL,kind TEXT NOT NULL,amount_micros INTEGER NOT NULL,status TEXT NOT NULL,evidence TEXT,created_at INTEGER NOT NULL,UNIQUE(user_id,reference));
INSERT OR IGNORE INTO migrations(version,applied_at) VALUES(1,unixepoch()*1000);
`;

export function dataDirectory(): string {
  const path = process.env.ORCUS_DATA_DIR ?? join(homedir(), ".local", "share", "orcus-ethglobal");
  if (!isAbsolute(path)) throw new ApiError("INVALID_DATA_PATH", "ORCUS_DATA_DIR must be an absolute path outside the checkout.", 503);
  const resolved = resolve(path);
  let dir = process.cwd();
  while (dirname(dir) !== dir && !existsSync(join(dir, ".git"))) dir = dirname(dir);
  if (existsSync(join(dir, ".git")) && (resolved === dir || resolved.startsWith(dir + sep))) throw new ApiError("INVALID_DATA_PATH", "Runtime data must remain outside the checkout.", 503);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (lstatSync(resolved).isSymbolicLink()) throw new ApiError("INVALID_DATA_PATH", "Runtime directory cannot be a symbolic link.", 503);
  chmodSync(resolved, 0o700);
  return resolved;
}
export const id = () => randomUUID();
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Store {
  readonly db: Database.Database;
  constructor(path = join(dataDirectory(), "platform.sqlite")) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(schema);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  getUser(address: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE address=?").get(address.toLowerCase()) as { id: string; address: string; created_at: number } | undefined;
    return row ? { id: row.id, address: row.address, createdAt: row.created_at } : undefined;
  }
  ensureUser(address: string): User {
    this.db.prepare("INSERT OR IGNORE INTO users(id,address,created_at) VALUES(?,?,?)").run(id(), address.toLowerCase(), Date.now());
    const user = this.getUser(address)!;
    this.db.prepare("INSERT OR IGNORE INTO budgets(user_id) VALUES(?)").run(user.id);
    return user;
  }
  createChallenge(address: string, origin: string) {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM challenges WHERE address=? AND expires_at>?").get(address.toLowerCase(), Date.now()+240_000) as { count: number };
    if (count.count >= 8) throw new ApiError("RATE_LIMITED", "Wait a minute before requesting another sign-in challenge.", 429);
    const challengeId = id(), expiresAt = Date.now()+300_000;
    const message = `${new URL(origin).host} wants you to sign in to Orcus.\n\nWallet: ${address.toLowerCase()}\nURI: ${origin}\nNonce: ${randomBytes(24).toString("hex")}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}\n\nThis signs you in only. It does not authorize trading or transfer funds.`;
    this.db.prepare("INSERT INTO challenges(id,address,message,expires_at) VALUES(?,?,?,?)").run(challengeId,address.toLowerCase(),message,expiresAt);
    return { id: challengeId, message, expiresAt };
  }
  challenge(challengeId: string) {
    const row = this.db.prepare("SELECT * FROM challenges WHERE id=?").get(challengeId) as { address: string; message: string; expires_at: number; consumed_at: number | null; attempts: number } | undefined;
    if (!row || row.consumed_at || row.expires_at<Date.now() || row.attempts>=5) throw new ApiError("INVALID_CHALLENGE", "Sign-in challenge expired or already used. Request a new one.", 401);
    this.db.prepare("UPDATE challenges SET attempts=attempts+1 WHERE id=?").run(challengeId);
    return row;
  }
  createSession(challengeId: string,address: string): { token: string; user: User } {
    return this.db.transaction(() => {
      const result = this.db.prepare("UPDATE challenges SET consumed_at=? WHERE id=? AND address=? AND consumed_at IS NULL AND expires_at>?").run(Date.now(),challengeId,address.toLowerCase(),Date.now());
      if (result.changes!==1) throw new ApiError("CHALLENGE_REPLAY", "This challenge is no longer available.", 401);
      const user = this.ensureUser(address), token = randomBytes(32).toString("hex");
      this.db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(tokenHash(token),user.id,Date.now()+86_400_000);
      return { token,user };
    })();
  }
  session(token?: string): User | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const row = this.db.prepare("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?").get(tokenHash(token),Date.now()) as { id: string; address: string; created_at: number } | undefined;
    return row ? { id: row.id,address: row.address,createdAt: row.created_at } : undefined;
  }
  logout(token: string) { this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token)); }
  get<T>(userId: string,kind: string,recordId: string): T | undefined {
    const row = this.db.prepare("SELECT body FROM records WHERE id=? AND user_id=? AND kind=?").get(recordId,userId,kind) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as T : undefined;
  }
  list<T>(userId: string,kind: string,limit=200): T[] {
    return (this.db.prepare("SELECT body FROM records WHERE user_id=? AND kind=? ORDER BY created_at DESC LIMIT ?").all(userId,kind,Math.min(limit,500)) as { body: string }[]).map(row=>JSON.parse(row.body) as T);
  }
  put<T extends StoredRecord>(kind: string,value: T): T {
    this.db.prepare("INSERT INTO records(id,user_id,kind,account_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at WHERE records.user_id=excluded.user_id AND records.kind=excluded.kind").run(value.id,value.userId,kind,value.accountId??null,JSON.stringify(value),value.createdAt,value.updatedAt);
    return value;
  }
  update<T extends StoredRecord>(userId: string,kind: string,recordId: string,patch: Partial<T>): T {
    const value = this.get<T>(userId,kind,recordId);
    if (!value) throw new ApiError("NOT_FOUND", "The requested record does not exist.", 404);
    return this.put(kind,{ ...value,...patch,id:value.id,userId:value.userId,createdAt:value.createdAt,updatedAt:Date.now() });
  }
  takeLease(scope: string,holder: string,ttl=60_000): boolean {
    return this.db.transaction(()=>{
      const existing = this.db.prepare("SELECT holder,expires_at FROM leases WHERE scope=?").get(scope) as { holder:string; expires_at:number } | undefined;
      if (existing && existing.expires_at>Date.now() && existing.holder!==holder) return false;
      this.db.prepare("INSERT INTO leases(scope,holder,expires_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at").run(scope,holder,Date.now()+ttl);
      return true;
    })();
  }
  renewLease(scope:string,holder:string,ttl:number):boolean {return this.db.prepare("UPDATE leases SET expires_at=? WHERE scope=? AND holder=? AND expires_at>?").run(Date.now()+ttl,scope,holder,Date.now()).changes===1;}
  releaseLease(scope:string,holder:string) { this.db.prepare("DELETE FROM leases WHERE scope=? AND holder=?").run(scope,holder); }
  dueAutomations<T>(limit=10):T[] {
    return (this.db.prepare("SELECT body FROM records WHERE kind='automation' AND json_extract(body,'$.status')='active' AND json_extract(body,'$.nextRunAt')<=? ORDER BY created_at LIMIT ?").all(Date.now(),limit) as {body:string}[]).map(row=>JSON.parse(row.body) as T);
  }
}
let singleton: Store|undefined;
export const getStore=()=>singleton??=new Store();
