import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { containsCredentialMaterial, rejectCredentialMaterial } from "./input-guard";
import { boundedMessages, compactObservation } from "../memory/context";
import { buildAgentTools } from "./tools";

const generated = () => randomBytes(18).toString("base64url");

describe("credential input guard", () => {
  it.each(["mk-", "sk-", "mk_", "sk_", "pk_"])("rejects generated %s credential tokens", prefix => {
    const input = `Remember this: ${prefix}${generated()}`;
    expect(() => rejectCredentialMaterial(input)).toThrow(expect.objectContaining({ code: "CREDENTIAL_INPUT_REJECTED" }));
  });

  it.each(["private key", "private_key", "seed phrase", "mnemonic", "apiKey", "password"])("rejects explicit %s assignments without reflecting their contents", label => {
    const secret = generated();
    let caught: unknown;
    try { rejectCredentialMaterial(`${label}: ${secret}`); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "CREDENTIAL_INPUT_REJECTED" });
    expect(String(caught)).not.toContain(secret);
  });

  it("keeps clearly labeled public transaction hashes and key-safety preferences usable", () => {
    const hash = `0x${randomBytes(32).toString("hex")}`;
    const input = `Inspect public transaction hash ${hash}. Never share private keys.`;
    expect(containsCredentialMaterial(input)).toBe(false);
    expect(compactObservation(input)).toBe(input);
    expect(() => rejectCredentialMaterial(hash)).toThrow(expect.objectContaining({ code: "CREDENTIAL_INPUT_REJECTED" }));
  });

  it("rejects labeled private keys while removing credential fields from retrieved objects", () => {
    const privateKey = `0x${randomBytes(32).toString("hex")}`;
    expect(() => rejectCredentialMaterial(`private key = ${privateKey}`)).toThrow(expect.objectContaining({ code: "CREDENTIAL_INPUT_REJECTED" }));
    expect(compactObservation({ seedPhrase: generated(), mnemonic: generated(), password: generated(), content: "Use conservative amounts." })).toEqual({ content: "Use conservative amounts." });
    expect(() => rejectCredentialMaterial(`Authorization: Bearer ${generated()}`)).toThrow(expect.objectContaining({ code: "CREDENTIAL_INPUT_REJECTED" }));
  });

  it("redacts legacy history and retrieved note credentials before prompt compaction", () => {
    const credential = `mk-${generated()}`;
    const result = JSON.stringify({ history: boundedMessages([{ role: "user", content: credential }]), memory: compactObservation({ notes: [{ content: `api key: ${credential}` }] }) });
    expect(result).not.toContain(credential);
    expect(result).toContain("credential-containing text omitted");
  });

  it("does not save generated management credentials through a memory tool", async () => {
    const content = `mk-${generated()}`;
    const remember = vi.fn(async () => { throw new Error("Memory must not be reached"); });
    const tool = buildAgentTools({ memoryStore: { search: async () => [], remember, forget: async () => false } }, `Remember ${content}`).get("remember_preference")!;
    await expect(tool.run({ content, sourceQuote: content })).rejects.toMatchObject({ code: "MEMORY_SECRET_REJECTED" });
    expect(remember).not.toHaveBeenCalled();
  });
});
