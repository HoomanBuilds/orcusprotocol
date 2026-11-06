import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function withGalileoFork<T>(run: (fork: { rpcUrl: string; block: string; rpc: (method: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>) {
  const source = process.env.ORCUS_GALILEO_FORK_SOURCE_RPC ?? "https://evmrpc-testnet.0g.ai";
  async function call(url: string, method: string, params: unknown[] = []) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { result?: unknown; error?: unknown };
    if (!response.ok || body.error || body.result === undefined) throw new Error(`The Galileo fork refused ${method}.`);
    return body.result;
  }
  assert.equal(await call(source, "eth_chainId"), "0x40da", "The fork source must be actual Galileo testnet, not production.");
  const block = process.env.ORCUS_GALILEO_FORK_BLOCK ?? BigInt(String(await call(source, "eth_blockNumber"))).toString();
  assert.match(block, /^\d+$/);
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(process.env.ANVIL_PATH ?? "anvil", ["--fork-url", source, "--fork-block-number", block, "--host", "127.0.0.1", "--port", String(port), "--chain-id", "16602", "--silent"], { stdio: "ignore" });
  let startupError = false; anvil.once("error", () => { startupError = true; });
  const rpc = (method: string, params: unknown[] = []) => call(rpcUrl, method, params);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError || anvil.exitCode !== null) throw new Error("The isolated Galileo Anvil fork could not start.");
      try { if (String(await rpc("web3_clientVersion")).toLowerCase().includes("anvil")) { ready = true; break; } } catch {}
      await delay(200);
    }
    if (!ready) throw new Error("The isolated Galileo fork did not become ready.");
    assert.equal(await rpc("eth_chainId"), "0x40da"); assert.equal(new URL(rpcUrl).hostname, "127.0.0.1");
    return await run({ rpcUrl, rpc, block });
  } finally {
    if (anvil.exitCode === null && !startupError) { anvil.kill("SIGTERM"); await Promise.race([new Promise<void>(resolve => anvil.once("exit", () => resolve())), delay(3000)]); if (anvil.exitCode === null) anvil.kill("SIGKILL"); }
  }
}
