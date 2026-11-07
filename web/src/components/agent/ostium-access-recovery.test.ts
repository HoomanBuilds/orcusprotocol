import { describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import type { TradingAccount } from "@orcus/core";
import { archivedAccess, isArchivedAccess, restartOstiumSetup, type AccessJournal, type DisableResult } from "./ostium-access-recovery";

const owner = `0x${"1".repeat(40)}`, oldSigner = `0x${"2".repeat(40)}`, newSigner = `0x${"3".repeat(40)}`;
const account = { id: "account", venue: "ostium", chainId: 421614, ownerAddress: owner, address: owner, agentAddress: oldSigner, controlRevision: 1 } as TradingAccount;
const journal = { version: 1, purpose: "grant", status: "started", account, permission: { id: "original", agentAddress: oldSigner }, plan: { expiresAt: 123 } } as AccessJournal;
const result = (changes: Partial<DisableResult> = {}): DisableResult => ({ account, nativeAuthority: { delegate: zeroAddress }, requiresOwnerRevocation: false, ...changes });
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value); }), key: (index: number) => [...data.keys()][index] ?? null, get length() { return data.size; } };
}

describe("unfinished Ostium setup recovery", () => {
  it("archives before disabling access, rotates the old signer, and never activates a grant", async () => {
    const saved = storage(), current = vi.fn();
    const request = vi.fn(async (input: { action: string }) => {
      expect(isArchivedAccess(saved, account, journal)).toBe(true);
      return result({ account: input.action === "rotate" ? { ...account, agentAddress: newSigner } : account });
    });
    expect((await restartOstiumSetup(saved, account, journal, request, current)).account.agentAddress).toBe(newSigner);
    expect(request.mock.calls.map(([input]) => input.action)).toEqual(["revoke", "rotate"]);
    expect(archivedAccess(saved, account)[0].journal).toEqual(journal);
    expect(current).toHaveBeenCalledTimes(3);
  });

  it("keeps an already rotated current signer and never overwrites original evidence", async () => {
    const saved = storage(), request = vi.fn(async () => result({ account: { ...account, agentAddress: newSigner } }));
    await restartOstiumSetup(saved, account, journal, request, () => {});
    const first = archivedAccess(saved, account);
    await restartOstiumSetup(saved, account, { ...journal, transactionHash: `0x${"a".repeat(64)}` }, request, () => {});
    expect(request.mock.calls).toHaveLength(2);
    expect(saved.setItem).toHaveBeenCalledTimes(1);
    expect(archivedAccess(saved, account)).toEqual(first);
  });

  it("preserves history and blocks restart when authority cannot be read", async () => {
    const saved = storage(), request = vi.fn(async () => result({ nativeAuthority: undefined, requiresOwnerRevocation: true }));
    await expect(restartOstiumSetup(saved, account, journal, request, () => {})).rejects.toThrow("could not be checked");
    expect(request).toHaveBeenCalledTimes(1);
    expect(archivedAccess(saved, account)).toHaveLength(1);
  });

  it("does not rotate or replace an unrelated native delegate", async () => {
    const request = vi.fn(async () => result({ nativeAuthority: { delegate: `0x${"4".repeat(40)}` } }));
    await expect(restartOstiumSetup(storage(), account, journal, request, () => {})).rejects.toThrow("Another delegate");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns managed native removal for separate owner review without signing", async () => {
    const removal = { delegate: zeroAddress } as NonNullable<DisableResult["ostium"]>;
    const request = vi.fn(async () => result({ account: { ...account, agentAddress: newSigner }, nativeAuthority: { delegate: oldSigner }, requiresOwnerRevocation: true, ostium: removal }));
    const checked = await restartOstiumSetup(storage(), account, journal, request, () => {});
    expect(checked.ostium).toBe(removal);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([{ purpose: "revoke" }, { status: "review" }, { permission: undefined }, { account: { ...account, ownerAddress: newSigner } }, { account: { ...account, id: "other" } }])("refuses unsuitable or foreign journals %j", async change => {
    const request = vi.fn();
    await expect(restartOstiumSetup(storage(), account, { ...journal, ...change } as AccessJournal, request, () => {})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not change permissions if durable history cannot be saved", async () => {
    const saved = storage(), request = vi.fn();
    saved.setItem.mockImplementation(() => { throw new Error("storage unavailable"); });
    await expect(restartOstiumSetup(saved, account, journal, request, () => {})).rejects.toThrow("storage unavailable");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["not JSON", "null", JSON.stringify({ archivedAt: 123, journal: {} }), JSON.stringify({ archivedAt: 123, journal: { ...journal, permission: { id: "original", agentAddress: 42 } } })])("fails closed on malformed history %s", async raw => {
    const saved = storage(), request = vi.fn();
    await restartOstiumSetup(saved, account, journal, async () => result({ account: { ...account, agentAddress: newSigner } }), () => {});
    saved.setItem(saved.key(0)!, raw);
    expect(() => archivedAccess(saved, account)).toThrow("could not be read");
    await expect(restartOstiumSetup(saved, account, journal, request, () => {})).rejects.toThrow("could not be read");
    expect(request).not.toHaveBeenCalled();
  });

  it("isolates history by account and owner and stops when the user changes", async () => {
    const saved = storage();
    await restartOstiumSetup(saved, account, journal, async () => result({ account: { ...account, agentAddress: newSigner } }), () => {});
    expect(archivedAccess(saved, { ...account, id: "another" })).toEqual([]);
    expect(archivedAccess(saved, { ...account, ownerAddress: newSigner })).toEqual([]);
    const check = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("account changed"); });
    const request = vi.fn(async () => result());
    await expect(restartOstiumSetup(saved, account, journal, request, check)).rejects.toThrow("account changed");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
