import type { AgentPermission, TradingAccount } from "@orcus/core";
import type { OstiumDelegationPlan } from "@orcus/wallets/ostium";
import { isAddress, zeroAddress } from "viem";

export type AccessJournal = { version: 1; purpose: "grant" | "revoke"; status: "review" | "started"; account: TradingAccount; plan: OstiumDelegationPlan; permission?: AgentPermission; transactionHash?: string };
export type DisableResult = { account: TradingAccount; requiresOwnerRevocation: boolean; ostium?: OstiumDelegationPlan; nativeAuthority?: { delegate: string }; message?: string };
export type ArchivedAccess = { archivedAt: number; journal: AccessJournal };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "key" | "length">;
type PermissionRequest = (input: { accountId: string; action: "revoke" | "rotate" }) => Promise<DisableResult>;

export function nativeJournalKey(account: TradingAccount) { return `orcus:ostium-access:v1:${account.ownerAddress.toLowerCase()}:${account.id}`; }
const archivePrefix = (account: TradingAccount) => `${nativeJournalKey(account)}:history:`;
const archiveKey = (account: TradingAccount, journal: AccessJournal) => `${archivePrefix(account)}${encodeURIComponent(journal.permission?.id ?? "")}:${journal.plan.expiresAt}`;
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function isArchivedAccess(storage: Storage, account: TradingAccount, journal: AccessJournal) {
  return storage.getItem(archiveKey(account, journal)) !== null;
}

export function archivedAccess(storage: Storage, account: TradingAccount): ArchivedAccess[] {
  const entries: ArchivedAccess[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(archivePrefix(account))) continue;
    let entry: ArchivedAccess | null;
    try { entry = JSON.parse(storage.getItem(key) ?? "null") as ArchivedAccess | null; }
    catch { throw new Error("Saved setup history could not be read. No new permission was requested."); }
    const journal = entry?.journal;
    if (!entry || !Number.isFinite(entry.archivedAt) || entry.archivedAt <= 0 || journal?.version !== 1 || journal.purpose !== "grant" || journal.status !== "started" || journal.account?.id !== account.id || typeof journal.account?.ownerAddress !== "string" || !same(journal.account.ownerAddress, account.ownerAddress) || typeof journal.permission?.id !== "string" || !journal.permission.id || typeof journal.permission.agentAddress !== "string" || !isAddress(journal.permission.agentAddress) || !Number.isFinite(journal.plan?.expiresAt) || journal.transactionHash !== undefined && !/^0x[\da-fA-F]{64}$/.test(journal.transactionHash)) throw new Error("Saved setup history could not be read. No new permission was requested.");
    entries.push(entry);
  }
  return entries.sort((a, b) => b.archivedAt - a.archivedAt);
}

export async function restartOstiumSetup(storage: Storage, account: TradingAccount, journal: AccessJournal, request: PermissionRequest, assertCurrent: () => void) {
  if (journal.purpose !== "grant" || journal.status !== "started" || !journal.permission?.id || journal.account.id !== account.id || !same(journal.account.ownerAddress, account.ownerAddress) || account.venue !== "ostium" || account.chainId !== 421614) throw new Error("Only an unfinished agent setup can be restarted.");
  assertCurrent();
  archivedAccess(storage, account);
  const key = archiveKey(account, journal);
  if (!isArchivedAccess(storage, account, journal)) {
    const saved = JSON.stringify({ archivedAt: Date.now(), journal } satisfies ArchivedAccess);
    storage.setItem(key, saved);
    if (storage.getItem(key) !== saved) throw new Error("Setup history could not be saved. Nothing was restarted.");
  }
  const check = (result: DisableResult) => {
    assertCurrent();
    if (result.account.id !== account.id || !same(result.account.ownerAddress, account.ownerAddress) || !result.nativeAuthority) throw new Error("Ostium access could not be checked. Agent access stays off; try again.");
    if (!same(result.nativeAuthority.delegate, zeroAddress) && !result.requiresOwnerRevocation) throw new Error("Another delegate is active on Ostium. Remove it in Ostium before starting again; it was not changed.");
    if (result.requiresOwnerRevocation && !result.ostium) throw new Error("The existing access needs removal, but its review is unavailable. Try again.");
    return result;
  };
  let result = check(await request({ accountId: account.id, action: "revoke" }));
  if (same(result.account.agentAddress, journal.permission.agentAddress)) result = check(await request({ accountId: account.id, action: "rotate" }));
  return result;
}
