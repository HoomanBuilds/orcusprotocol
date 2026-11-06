import { fundingRecovery } from "./trade-ux";

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function depositRecoveryKey(owner: string, accountId: string) {
  return `orcus:trading-deposit:${owner.toLowerCase()}:${accountId}`;
}

export function readDepositRecovery(local: RecoveryStorage, session: RecoveryStorage, owner: string, accountId: string) {
  const key = depositRecoveryKey(owner, accountId);
  const legacyKey = `orcus:trading-deposit:${owner}:${accountId}`;
  for (const [storage, candidate] of [[local, key], [local, legacyKey], [session, key], [session, legacyKey]] as const) {
    try {
      const recovery = fundingRecovery(JSON.parse(storage.getItem(candidate) ?? "null"));
      if (!recovery) continue;
      try { local.setItem(key, JSON.stringify(recovery)); } catch {}
      return recovery;
    } catch {}
  }
  return null;
}

export function clearDepositRecovery(local: RecoveryStorage, session: RecoveryStorage, owner: string, accountId: string) {
  for (const storage of [local, session]) {
    for (const key of new Set([depositRecoveryKey(owner, accountId), `orcus:trading-deposit:${owner}:${accountId}`])) {
      try { storage.removeItem(key); } catch {}
    }
  }
}
