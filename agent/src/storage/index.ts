import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineConfig } from "../config";
import { EngineError } from "../errors";
import { boundedStorageSigner, type StorageUploadOptions } from "./expenses";
export { reconcileStorageExpense } from "./expenses";

const HEADER = Buffer.from("ORCUSMEM1");

function keyBytes(key: string | Uint8Array): Buffer {
  const bytes = typeof key === "string" ? Buffer.from(key.replace(/^0x/, ""), "hex") : Buffer.from(key);
  if (bytes.length !== 32) throw new EngineError("INVALID_MEMORY_KEY", "Memory encryption requires a separate 32-byte key.");
  return bytes;
}

export function encryptMemory(memory: unknown, key: string | Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(HEADER);
  const plaintext = Buffer.from(JSON.stringify(memory), "utf8");
  if (plaintext.length > 1_000_000) throw new EngineError("MEMORY_TOO_LARGE", "Memory snapshots must be smaller than 1 MB.");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([HEADER, iv, cipher.getAuthTag(), encrypted]);
}

export function decryptMemory(bytes: Uint8Array, key: string | Uint8Array): unknown {
  const payload = Buffer.from(bytes);
  if (payload.length < HEADER.length + 28 || !payload.subarray(0, HEADER.length).equals(HEADER)) throw new EngineError("INVALID_MEMORY", "The memory object has an invalid format.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), payload.subarray(HEADER.length, HEADER.length + 12));
    decipher.setAAD(HEADER);
    decipher.setAuthTag(payload.subarray(HEADER.length + 12, HEADER.length + 28));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(HEADER.length + 28)), decipher.final()]).toString("utf8"));
  } catch { throw new EngineError("MEMORY_AUTHENTICATION_FAILED", "Memory could not be authenticated with this user's key."); }
}

export async function uploadMemory(memory: unknown, encryptionKey: string | Uint8Array, signerPrivateKey?: string, options: StorageUploadOptions = {}) {
  const cfg = engineConfig().storage;
  if (!cfg.configured || !signerPrivateKey) throw new EngineError("STORAGE_NOT_CONFIGURED", "0G Storage is not enabled with an authorized testnet operating signer.", 503);
  const { JsonRpcProvider } = await import("ethers");
  const { Indexer, MemData } = await import("@0gfoundation/0g-storage-ts-sdk");
  const provider = new JsonRpcProvider(cfg.rpcUrl);
  if ((await provider.getNetwork()).chainId !== 16602n) throw new EngineError("WRONG_NETWORK", "0G Storage writes are limited to Galileo testnet.");
  const data = new MemData(encryptMemory(memory, encryptionKey));
  const [tree, treeError] = await data.merkleTree();
  if (treeError || !tree) throw new EngineError("STORAGE_HASH_FAILED", "Could not calculate the encrypted memory object root.", 502);
  const rootHash = tree.rootHash();
  if (!rootHash || !/^0x[\da-fA-F]{64}$/.test(rootHash)) throw new EngineError("STORAGE_HASH_FAILED", "The encrypted memory root is invalid.", 502);
  const deadline = Date.now() + 90_000;
  const assertDeadline = () => { if (Date.now() > deadline) throw new EngineError("STORAGE_SYNC_TIMEOUT", "Storage synchronization timed out. Reconcile the submitted transaction instead of repeating this backup.", 504); };
  const guard = boundedStorageSigner(signerPrivateKey, provider, rootHash, { ...options, assertAuthority: async () => { await options.assertAuthority?.(); assertDeadline(); } });
  const indexer = new Indexer(cfg.indexerUrl);
  try {
    const [uploader, selectionError] = await indexer.newUploaderFromIndexerNodes(cfg.rpcUrl, guard.signer, 1);
    if (selectionError || !uploader) throw new EngineError("STORAGE_SELECTION_FAILED", "No usable storage nodes were available for this backup.", 502);
    const flowAddress = await uploader.flow.getAddress(), selector = uploader.flow.interface.getFunction("submit")?.selector;
    if (!selector || await provider.getCode(flowAddress) === "0x") throw new EngineError("INVALID_STORAGE_FLOW", "The selected Galileo Flow contract is unavailable.", 502);
    guard.allowFlow(flowAddress, selector);
    const [transaction, uploadError] = await uploader.uploadFile(data, { finalityRequired: true, expectedReplica: 1, skipIfFinalized: false, onProgress: assertDeadline }, { Retries: 1, Interval: 1, MaxGasPrice: 0 });
    const expense = await guard.expense();
    if (uploadError || !transaction || transaction.rootHash !== rootHash || expense?.status !== "confirmed" || transaction.txHash.toLowerCase() !== expense.transactionHash.toLowerCase()) throw new EngineError("STORAGE_UPLOAD_UNCONFIRMED", "The backup is not confirmed. Its submitted transaction must be reconciled before another upload.", 502);
    const available = await Promise.all(uploader.nodes.map(node => node.getFileInfo(rootHash, true).catch(() => null)));
    if (!available.some(info => info?.finalized && info.tx.dataMerkleRoot === rootHash)) throw new EngineError("STORAGE_FINALITY_UNCONFIRMED", "The transaction was paid, but encrypted object availability is not confirmed. No backup is marked successful.", 502);
    return { status: "confirmed" as const, rootHash, txHash: expense.transactionHash, expense, encrypted: true, network: "galileo-testnet", uploadedAt: Date.now() };
  } catch (error) {
    if (guard.candidateHash()) { try { await guard.expense(); } catch {} }
    throw Object.assign(error instanceof EngineError ? error : new EngineError("STORAGE_UPLOAD_FAILED", "The encrypted backup could not be confirmed. No automatic upload retry will occur.", 502), { phase: guard.attempted() ? "submitted-unknown" : "not-submitted", evidence: { transactionHash: guard.candidateHash(), rootHash } });
  }
}

export async function downloadMemory(rootHash: string, encryptionKey: string | Uint8Array) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(rootHash)) throw new EngineError("INVALID_ROOT", "A valid 0G object root is required.");
  const cfg = engineConfig().storage;
  if (!cfg.configured) throw new EngineError("STORAGE_NOT_CONFIGURED", "0G Storage is not enabled.", 503);
  const { Indexer } = await import("@0gfoundation/0g-storage-ts-sdk");
  const directory = await mkdtemp(join(tmpdir(), "orcus-memory-"));
  const output = join(directory, "encrypted.bin");
  try {
    const error = await new Indexer(cfg.indexerUrl).download(rootHash, output, true);
    if (error) throw new EngineError("STORAGE_DOWNLOAD_FAILED", "The encrypted memory object could not be downloaded and verified.", 502);
    return decryptMemory(await readFile(output), encryptionKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
