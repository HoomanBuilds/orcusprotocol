import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineConfig } from "../config";
import { EngineError } from "../errors";

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

export async function uploadMemory(memory: unknown, encryptionKey: string | Uint8Array, signerPrivateKey?: string) {
  const cfg = engineConfig().storage;
  if (!cfg.configured || !signerPrivateKey) throw new EngineError("STORAGE_NOT_CONFIGURED", "0G Storage is not enabled with an authorized testnet operating signer.", 503);
  const { JsonRpcProvider, Wallet } = await import("ethers");
  const { Indexer, MemData } = await import("@0gfoundation/0g-storage-ts-sdk");
  const provider = new JsonRpcProvider(cfg.rpcUrl);
  if ((await provider.getNetwork()).chainId !== 16602n) throw new EngineError("WRONG_NETWORK", "0G Storage writes are limited to Galileo testnet.");
  const signer = new Wallet(signerPrivateKey, provider);
  const data = new MemData(encryptMemory(memory, encryptionKey));
  const [tree, treeError] = await data.merkleTree();
  if (treeError || !tree) throw new EngineError("STORAGE_HASH_FAILED", "Could not calculate the encrypted memory object root.", 502);
  const indexer = new Indexer(cfg.indexerUrl);
  const [transaction, uploadError] = await indexer.upload(data, cfg.rpcUrl, signer);
  if (uploadError || !transaction) throw new EngineError("STORAGE_UPLOAD_FAILED", "The encrypted memory upload failed. No persisted object is claimed.", 502);
  const record = transaction as unknown as { rootHash?: string; txHash?: string; txHashes?: string[] };
  const rootHash = record.rootHash ?? tree.rootHash();
  return { status: "confirmed" as const, rootHash, txHash: record.txHash ?? record.txHashes?.[0], encrypted: true, network: "galileo-testnet", uploadedAt: Date.now() };
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
