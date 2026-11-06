import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { Indexer, MemData, StorageNode } from "@0gfoundation/0g-storage-ts-sdk";
import { JsonRpcProvider, WebSocketProvider } from "ethers";
import { decryptMemory, encryptMemory } from "./index";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const instance = createServer(handler);
  await new Promise<void>((resolve, reject) => { instance.once("error", reject); instance.listen(0, "127.0.0.1", resolve); });
  const port = (instance.address() as { port: number }).port;
  cleanup.push(() => new Promise<void>((resolve, reject) => { instance.closeAllConnections(); instance.close(error => error ? reject(error) : resolve()); }));
  return { instance, url: `http://127.0.0.1:${port}`, websocketUrl: `ws://127.0.0.1:${port}` };
}

describe("patched storage dependency transports", () => {
  it("uses the real SDK HTTP provider for node and indexer JSON-RPC", async () => {
    const requests: { method: string; params?: unknown[] }[] = [];
    const status = { connectedPeers: 2, logSyncHeight: 123, nextTxSeq: 5, networkIdentity: { chainId: 16602 } };
    const endpoint = await server(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ method: payload.method, params: payload.params });
      expect(request.method).toBe("POST");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: payload.method === "zgs_getStatus" ? status : null }));
    });
    expect(await new StorageNode(endpoint.url).getStatus()).toEqual(status);
    expect(await new Indexer(endpoint.url).getFileLocations(`0x${"12".repeat(32)}`)).toEqual([]);
    expect(requests).toEqual([{ method: "zgs_getStatus" }, { method: "indexer_getFileLocations", params: [`0x${"12".repeat(32)}`] }]);
  });

  it("preserves structured RPC errors instead of treating them as storage success", async () => {
    const endpoint = await server(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32001, message: "Storage node unavailable" } }));
    });
    await expect(new StorageNode(endpoint.url).getStatus()).rejects.toMatchObject({ code: -32001, message: "Storage node unavailable" });
  });

  it("retains encrypted memory and SDK Merkle-tree compatibility without a public upload", async () => {
    const key = new Uint8Array(32).fill(7), memory = { version: 1, preferences: { maxOrder: "10" } };
    const encrypted = encryptMemory(memory, key), file = new MemData(encrypted);
    const [tree, error] = await file.merkleTree();
    expect(error).toBeNull();
    expect(tree?.rootHash()).toMatch(/^0x[0-9a-f]{64}$/iu);
    expect(file.size()).toBe(encrypted.length);
    expect(decryptMemory(encrypted, key)).toEqual(memory);
    encrypted[encrypted.length - 1] ^= 1;
    expect(() => decryptMemory(encrypted, key)).toThrow(/authenticated/);
  });

  it("keeps ethers HTTP and patched WebSocket JSON-RPC transports functional", async () => {
    const reply = (payload: { id: number; method: string }) => ({ jsonrpc: "2.0", id: payload.id, result: payload.method === "eth_chainId" ? "0x40da" : "0x2a" });
    const endpoint = await server(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(Array.isArray(payload) ? payload.map(reply) : reply(payload)));
    });
    const { WebSocketServer } = createRequire(import.meta.url)("ws");
    const sockets = new WebSocketServer({ server: endpoint.instance });
    sockets.on("connection", (socket: { on: (event: string, callback: (data: Buffer) => void) => void; send: (data: string) => void }) => {
      socket.on("message", data => socket.send(JSON.stringify(reply(JSON.parse(data.toString())))));
    });
    cleanup.push(() => new Promise<void>((resolve, reject) => sockets.close((error?: Error) => error ? reject(error) : resolve())));
    const http = new JsonRpcProvider(endpoint.url), websocket = new WebSocketProvider(endpoint.websocketUrl);
    cleanup.push(async () => { http.destroy(); await websocket.destroy(); });
    expect((await http.getNetwork()).chainId).toBe(16602n);
    expect(await http.getBlockNumber()).toBe(42);
    expect((await websocket.getNetwork()).chainId).toBe(16602n);
    expect(await websocket.getBlockNumber()).toBe(42);
  });
});
