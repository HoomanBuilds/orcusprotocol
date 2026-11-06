import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateInferenceSession, parseGatewayAttestation, privateResponseEvidence, verifierEnvironment } from "./privacy";

const { mockRequest, mockExecute } = vi.hoisted(() => ({ mockRequest: vi.fn(), mockExecute: vi.fn() }));
vi.mock("node:https", () => ({ request: mockRequest }));
vi.mock("node:child_process", () => ({ execFile: mockExecute }));

const gateway = "router-api.0g.ai";
const url = `https://${gateway}/v1/chat/completions`;
const model = "0gm-1.0-35b-a3b";
const certificate = Buffer.from("unit-test-certificate");
const certificateSha = createHash("sha256").update(certificate).digest("hex");
const composeSha = "a".repeat(64);
const provider = `0x${"b".repeat(40)}`;
const now = Date.now();
const report = `gateway            ${gateway}
ok quote              genuine TDX (DCAP verified)
ok endpoint binding   matches
  served cert      ${certificateSha}
  not after        ${new Date(now + 86_400_000).toISOString()}
ok compose_hash       ${composeSha}
ok app-compose        sha256 == compose_hash (authenticated)
ok compose file       matches release-2026.11.05.1 byte-for-byte
ok os image           dstack-0.6.1
ok chain              mainnet, as the gateway reports it (want mainnet)

PASS
`;
const body = { id: "chat-provider-id", x_0g_trace: { request_id: "request-id", provider }, choices: [{ message: { content: "ok" } }] };
const responseHeaders = { "x-0g-e2ee": "sealed", "zg-res-key": "provider-signature-id", "x-0g-gateway-instance": "gateway-instance" };
const headers = () => new Headers(responseHeaders);
function catalog(verifiability = "TeeML") {
  const fetcher = vi.fn(async () => Response.json({ data: [{ id: model, type: "chatbot", verifiability }] }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); mockRequest.mockReset(); mockExecute.mockReset(); });

describe("independent gateway attestation", () => {
  it("records the bound certificate, measured code, verified report digest, and short expiry", () => {
    expect(parseGatewayAttestation(report, 0, gateway, "mainnet", now)).toMatchObject({ gateway, certificateSha256: certificateSha, composeSha256: composeSha, network: "mainnet", expiresAt: now + 300_000 });
  });

  it.each([
    [report, 1],
    [report.replace("PASS", "PASS (INCOMPLETE)"), 0],
    [report.replace(certificateSha, "bad"), 0],
    [report.replace("mainnet,", "testnet,"), 0],
    [report.replace(gateway, "other.example"), 0],
    [report.replace("authenticated", "unauthenticated"), 0],
    [report.replace("PASS", "not compared\nPASS"), 0],
  ])("rejects partial, failed, unbound, or wrong-network evidence", (output, exitCode) => {
    expect(() => parseGatewayAttestation(output as string, exitCode as number, gateway)).toThrow(expect.objectContaining({ code: "PRIVATE_INFERENCE_UNVERIFIED" }));
  });

  it("never forwards application credentials or signing keys to the verifier process", () => {
    vi.stubEnv("ZEROG_COMPUTE_API_KEY", "not-a-real-key");
    vi.stubEnv("PRIVATE_KEY", "not-a-real-signing-key");
    vi.stubEnv("PATH", "/bin");
    expect(verifierEnvironment()).toMatchObject({ PATH: "/bin" });
    expect(verifierEnvironment()).not.toHaveProperty("ZEROG_COMPUTE_API_KEY");
    expect(verifierEnvironment()).not.toHaveProperty("PRIVATE_KEY");
  });
});

describe("sealed execution evidence", () => {
  it("accepts the actual sealed gateway schema without inventing an absent tee_verified flag", () => {
    const evidence = privateResponseEvidence(headers(), body);
    expect(evidence).toMatchObject({ status: "gateway-reported-private", requestId: "request-id", responseId: "provider-signature-id", providerAddress: provider, providerVerification: "reported-by-gateway" });
    expect(evidence).not.toHaveProperty("routerTeeVerified");
    expect(evidence).not.toHaveProperty("attestation");
  });

  it("distinguishes hardware and code attestation from a gateway's assertion", () => {
    const attestation = parseGatewayAttestation(report, 0, gateway);
    expect(privateResponseEvidence(headers(), body, attestation)).toMatchObject({ status: "independently-attested-private", attestation, providerVerification: "enforced-by-attested-gateway" });
  });

  it.each([null, {}, { ...body, x_0g_trace: {} }, { ...body, x_0g_trace: { ...body.x_0g_trace, tee_verified: false } }, { ...body, x_0g_trace: { ...body.x_0g_trace, provider: "not-an-address" } }])("fails closed on missing or negative provider evidence", value => {
    expect(() => privateResponseEvidence(headers(), value)).toThrow(expect.objectContaining({ code: "PRIVATE_INFERENCE_UNVERIFIED" }));
  });

  it("refuses cleartext fallback and inconsistent provider headers", () => {
    expect(() => privateResponseEvidence(new Headers({ "x-0g-e2ee": "none" }), body)).toThrow();
    const inconsistent = headers(); inconsistent.set("x-provider", `0x${"c".repeat(40)}`);
    expect(() => privateResponseEvidence(inconsistent, body)).toThrow();
  });

  it("refuses expired gateway evidence", () => {
    const attestation = parseGatewayAttestation(report, 0, gateway);
    expect(() => privateResponseEvidence(headers(), body, { ...attestation, expiresAt: 0 })).toThrow();
  });
});

describe("private routing", () => {
  it.each(["http://router-api.0g.ai/v1/chat/completions", `${url}/`, `${url}?fallback=true`, "https://user:password@router-api.0g.ai/v1/chat/completions", "https://router-api.0g.ai/v1/other"]) ("refuses noncanonical endpoints before contacting anything", async endpoint => {
    const fetcher = catalog();
    await expect(createPrivateInferenceSession({ url: endpoint, model })).rejects.toMatchObject({ code: "PRIVATE_INFERENCE_UNVERIFIED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks the exact model and never sends inference on public-only models", async () => {
    catalog("none");
    await expect(createPrivateInferenceSession({ url, model, verification: "gateway-reported" })).rejects.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("defaults to independent verification and never silently downgrades", async () => {
    catalog();
    await expect(createPrivateInferenceSession({ url, model })).rejects.toThrow(/official 0G pcverify/);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("runs the official strict verifier without credentials and pins the inference certificate", async () => {
    catalog();
    mockExecute.mockImplementation((_path, _args, _options, callback) => callback(null, report, ""));
    const session = await createPrivateInferenceSession({ url, model, verifierPath: "/opt/0g/pcverify" });
    expect(mockExecute.mock.calls[0]![1]).toContain("-strict");
    expect(mockExecute.mock.calls[0]![2].env).not.toHaveProperty("ZEROG_COMPUTE_API_KEY");
    let options: Record<string, any> = {};
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn() });
    mockRequest.mockImplementation((_url, config, callback) => {
      options = config;
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { headers: responseHeaders, statusCode: 200 });
        callback(response); response.emit("data", Buffer.from(JSON.stringify(body))); response.emit("end");
      });
      return req;
    });
    const response = await session.request({ apiKey: "unit-test-key", body: { model }, timeoutMs: 1000 });
    const identity = { raw: certificate, subjectaltname: `DNS:${gateway}` };
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.checkServerIdentity(gateway, identity)).toBeUndefined();
    expect(options.checkServerIdentity(gateway, { ...identity, raw: Buffer.from("different-certificate") })).toBeInstanceOf(Error);
    expect(options.checkServerIdentity("wrong.example", identity)).toBeInstanceOf(Error);
    expect(session.evidence(response.headers, await response.json()).status).toBe("independently-attested-private");
  });

  it("does not contact inference when strict verification fails", async () => {
    catalog();
    mockExecute.mockImplementation((_path, _args, _options, callback) => callback(new Error("upstream manifest unavailable"), "FAIL", ""));
    await expect(createPrivateInferenceSession({ url, model, verifierPath: "/opt/0g/pcverify" })).rejects.toThrow(/official 0G gateway verifier failed/);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("does not follow inference redirects", async () => {
    catalog();
    const session = await createPrivateInferenceSession({ url, model, verification: "gateway-reported" });
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn() });
    mockRequest.mockImplementation((_url, _config, callback) => {
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { headers: { location: "https://other.example/" }, statusCode: 302 });
        callback(response); response.emit("end");
      });
      return req;
    });
    await expect(session.request({ apiKey: "unit-test-key", body: { model }, timeoutMs: 1000 })).rejects.toThrow(/redirects are refused/);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("forces private provider routing and verification even if a caller tries to disable it", async () => {
    catalog();
    const session = await createPrivateInferenceSession({ url, model, verification: "gateway-reported" });
    let options: Record<string, any> = {};
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn() });
    mockRequest.mockImplementation((_url, config, callback) => {
      options = config;
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { headers: responseHeaders, statusCode: 200 });
        callback(response);
        response.emit("data", Buffer.from(JSON.stringify(body)));
        response.emit("end");
      });
      return req;
    });
    const response = await session.request({ apiKey: "unit-test-key", body: { model, messages: [], verify_tee: false }, timeoutMs: 1000 });
    expect(options.headers["X-0G-Provider-Trust-Mode"]).toBe("private");
    expect(options.agent).toBe(false);
    expect(JSON.parse(req.end.mock.calls[0]![0])).toMatchObject({ verify_tee: true, stream: false });
    expect(session.evidence(response.headers, await response.json()).status).toBe("gateway-reported-private");
    expect(() => session.request({ apiKey: "unit-test-key", body: { model: "different-model" }, timeoutMs: 1000 })).toThrow();
  });
});
