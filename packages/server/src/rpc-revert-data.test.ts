import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, encodeErrorResult, http, parseAbi } from "viem";
import { getSenderAddress } from "@zerodev/sdk/actions";
import { handleRequest } from "./http";
import { Store } from "./store";

const origin = "http://localhost:3000", upstream = "https://rpc.example/private-provider-key";
const sender = "0x2222222222222222222222222222222222222222";
const revertData = encodeErrorResult({ abi: parseAbi(["error SenderAddressResult(address sender)"]), errorName: "SenderAddressResult", args: [sender] });
let store: Store, cookie: string;
beforeEach(() => {
  store = new Store(":memory:");
  const user = store.ensureUser("0x1111111111111111111111111111111111111111"), challenge = store.createChallenge(user.address, origin);
  cookie = `orcus_session=${store.createSession(challenge.id, user.address).token}`;
  vi.stubEnv("ORCUS_APP_URL", origin);
  vi.stubEnv("SEPOLIA_RPC_URL", upstream);
});
afterEach(() => { store.db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const request = (method = "eth_call") => new Request(`${origin}/api/rpc`, { method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
const mockError = (data: unknown) => vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: upstream, data, debug: { apiKey: "private-provider-key" } } })));

describe("RPC revert data", () => {
  it("preserves bounded ABI revert bytes without provider diagnostics", async () => {
    mockError(revertData);
    const response = await handleRequest(request(), store), text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "The configured RPC rejected this request. Provider details were withheld.", data: revertData } });
    expect(text).not.toContain("private-provider-key");
  });

  it.each([undefined, null, 42, "0x1", "0xzz", "0x12 provider-secret", `0x${"aa".repeat(16_385)}`, { data: revertData, provider: upstream }, { originalError: { data: revertData, message: upstream } }])("withholds malformed, oversized and structured data %#", async data => {
    mockError(data);
    const result = await (await handleRequest(request(), store)).json();
    expect(result.error).not.toHaveProperty("data");
    expect(JSON.stringify(result)).not.toContain("private-provider-key");
  });

  it("does not forward arbitrary error data for other RPC methods", async () => {
    mockError(revertData);
    expect((await (await handleRequest(request("eth_getCode"), store)).json()).error).not.toHaveProperty("data");
  });

  it("keeps successful responses unchanged", async () => {
    const output = { jsonrpc: "2.0", id: 1, result: "0xaa36a7" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(output)));
    expect(await (await handleRequest(request("eth_chainId"), store)).json()).toEqual(output);
  });

  it("lets the real Kernel SDK derive an account through its intentional revert", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | Request, init?: RequestInit) => {
      if (String(input) === upstream) return Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: revertData } });
      const incoming = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(incoming.headers);
      headers.set("Origin", origin); headers.set("Cookie", cookie);
      return handleRequest(new Request(incoming, { headers }), store);
    }));
    const client = createPublicClient({ transport: http(`${origin}/api/rpc`, { retryCount: 0 }) });
    await expect(getSenderAddress(client, { initCode: "0x1234", entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" })).resolves.toBe(sender);
  });
});
