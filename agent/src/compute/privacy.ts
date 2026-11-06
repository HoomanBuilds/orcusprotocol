import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { checkServerIdentity } from "node:tls";
import { EngineError } from "../errors";

const responseLimit = 2 * 1024 * 1024;

export type PrivateVerification = "independent-gateway" | "gateway-reported";

export interface GatewayAttestation {
  gateway: string;
  certificateSha256: string;
  composeSha256: string;
  composeRelease: string;
  network: "mainnet" | "testnet";
  reportSha256: string;
  verifiedAt: number;
  expiresAt: number;
}

export interface PrivateInferenceEvidence {
  status: "independently-attested-private" | "gateway-reported-private";
  requestId: string;
  responseId: string;
  providerAddress: string;
  gatewayInstance?: string;
  providerVerification: "enforced-by-attested-gateway" | "reported-by-gateway";
  routerTeeVerified?: true;
  attestation?: GatewayAttestation;
}

export interface PrivateInferenceOptions {
  url: string;
  model: string;
  verification?: PrivateVerification;
  verifierPath?: string;
  appComposePath?: string;
  expectedComposePath?: string;
  expectedNetwork?: "mainnet" | "testnet";
  timeoutMs?: number;
}

function denied(message: string): never {
  throw new EngineError("PRIVATE_INFERENCE_UNVERIFIED", message, 503);
}

function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return denied("The private inference endpoint is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/chat/completions" || (url.port && url.port !== "443")) denied("Private inference requires the exact HTTPS /v1/chat/completions gateway endpoint, without redirects or credentials in the URL.");
  return url;
}

export function parseGatewayAttestation(report: string, exitCode: number, gateway: string, network: "mainnet" | "testnet" = "mainnet", now = Date.now()): GatewayAttestation {
  if (exitCode !== 0 || report.trimEnd().split("\n").at(-1)?.trim() !== "PASS" || /FAIL|INCOMPLETE|waived:|not pinned|not compared/.test(report)) denied("Independent 0G gateway verification did not complete. Private inference has not been sent.");
  const checkedGateway = report.match(/^gateway\s+(\S+)\s*$/m)?.[1];
  const certificateSha256 = report.match(/^\s+served cert\s+([a-f\d]{64})\s*$/m)?.[1];
  const composeSha256 = report.match(/compose_hash\s+([a-f\d]{64})\s*$/m)?.[1];
  const composeRelease = report.match(/compose file\s+matches (.+) byte-for-byte\s*$/m)?.[1];
  const certificateExpiry = Date.parse(report.match(/^\s+not after\s+(\S+)\s*$/m)?.[1] ?? "");
  if (checkedGateway !== gateway || !certificateSha256 || !composeSha256 || !composeRelease || !Number.isFinite(certificateExpiry) || certificateExpiry <= now || !report.includes("genuine TDX (DCAP verified)") || !report.includes("app-compose        sha256 == compose_hash (authenticated)") || !new RegExp(`chain\\s+${network},`).test(report)) denied("The 0G verifier report is missing a required certificate, code identity, hardware, or network binding.");
  return { gateway, certificateSha256, composeSha256, composeRelease, network, reportSha256: createHash("sha256").update(report).digest("hex"), verifiedAt: now, expiresAt: Math.min(certificateExpiry, now + 5 * 60_000) };
}

export function verifierEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "development" };
  for (const name of ["PATH", "HOME", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[name]) result[name] = process.env[name];
  return result;
}

async function verifyGateway(options: PrivateInferenceOptions, url: URL): Promise<GatewayAttestation> {
  if (!options.verifierPath || !isAbsolute(options.verifierPath)) denied("Independent private inference requires an absolute path to the official 0G pcverify executable.");
  const args = ["-gateway", url.hostname, "-strict", "-expect-network", options.expectedNetwork ?? "mainnet", "-timeout", "45s"];
  for (const [flag, value] of [["-app-compose", options.appComposePath], ["-expect-compose-file", options.expectedComposePath]]) {
    if (!value) continue;
    if (!isAbsolute(value)) denied("Gateway verification manifest paths must be absolute.");
    args.push(flag!, value);
  }
  try {
    const output = await new Promise<{ stdout: string }>((resolve, reject) => execFile(options.verifierPath!, args, { timeout: 50_000, maxBuffer: 512 * 1024, env: verifierEnvironment(), cwd: tmpdir(), windowsHide: true }, (error, stdout) => error ? reject(error) : resolve({ stdout })));
    return parseGatewayAttestation(output.stdout, 0, url.hostname, options.expectedNetwork);
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return denied("The official 0G gateway verifier failed or could not establish the gateway's complete hardware and code identity. No private request was sent.");
  }
}

export function privateResponseEvidence(headers: Headers, body: unknown, attestation?: GatewayAttestation): PrivateInferenceEvidence {
  if (headers.get("x-0g-e2ee") !== "sealed") denied("0G did not confirm sealed provider execution. The result must not be used as a private inference result.");
  if (!body || typeof body !== "object") denied("Private inference returned no usable verification evidence.");
  const data = body as Record<string, unknown>;
  const trace = data.x_0g_trace && typeof data.x_0g_trace === "object" ? data.x_0g_trace as Record<string, unknown> : {};
  if (trace.tee_verified === false) denied("The Router reported that provider verification failed.");
  const providerAddress = trace.provider;
  const requestId = trace.request_id;
  const responseId = headers.get("zg-res-key") ?? data.id;
  if (typeof providerAddress !== "string" || !/^0x[a-f\d]{40}$/i.test(providerAddress) || typeof requestId !== "string" || !requestId.trim() || requestId.length > 256 || typeof responseId !== "string" || !responseId.trim() || responseId.length > 256) denied("The sealed inference response is missing its provider address or request identifiers.");
  const providerHeader = headers.get("x-provider");
  if (providerHeader && providerHeader.toLowerCase() !== providerAddress.toLowerCase()) denied("The private inference response names inconsistent providers.");
  if (attestation && attestation.expiresAt <= Date.now()) denied("The gateway attestation expired before private inference completed.");
  return {
    status: attestation ? "independently-attested-private" : "gateway-reported-private",
    requestId, responseId, providerAddress,
    gatewayInstance: headers.get("x-0g-gateway-instance") ?? undefined,
    providerVerification: attestation ? "enforced-by-attested-gateway" : "reported-by-gateway",
    ...(trace.tee_verified === true ? { routerTeeVerified: true as const } : {}),
    ...(attestation ? { attestation } : {}),
  };
}

export async function createPrivateInferenceSession(options: PrivateInferenceOptions) {
  const url = endpoint(options.url);
  const verification = options.verification ?? "independent-gateway";
  if (!["independent-gateway", "gateway-reported"].includes(verification)) denied("Unknown private inference verification policy.");
  let catalog: unknown;
  try {
    const response = await fetch(new URL("/v1/models", url), { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000), redirect: "error" });
    if (!response.ok) denied("The private model catalog is unavailable.");
    catalog = await response.json();
  } catch { return denied("The private model catalog could not be checked. No inference was sent."); }
  const models = catalog && typeof catalog === "object" ? (catalog as { data?: unknown }).data : undefined;
  if (!Array.isArray(models) || !models.some(model => model && typeof model === "object" && model.id === options.model && model.verifiability === "TeeML" && model.type === "chatbot")) denied("The selected model is not a catalog-listed TeeML chat model. Private inference will not fall back to a public provider.");
  const attestation = verification === "independent-gateway" ? await verifyGateway(options, url) : undefined;

  return {
    verification,
    attestation,
    evidence: (headers: Headers, body: unknown) => privateResponseEvidence(headers, body, attestation),
    request(input: { apiKey: string; body: Record<string, unknown>; timeoutMs: number; priceCeilings?: { prompt: string; completion: string } }): Promise<Response> {
      if (input.body.model !== options.model || input.body.stream === true) denied("Private inference requires the checked model and a non-streaming response.");
      if (attestation && attestation.expiresAt <= Date.now()) denied("Gateway verification expired. Re-verify before sending private information.");
      if (!input.apiKey || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000) denied("Private inference credentials or timeout are invalid.");
      const priceHeaders: Record<string, string> = {};
      if (input.priceCeilings) {
        for (const field of ["prompt", "completion"] as const) {
          const value = input.priceCeilings[field];
          if (typeof value !== "string" || value.length > 64 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) denied("Private inference price ceilings must be non-negative decimal USD strings.");
          priceHeaders[`X-0G-Provider-Max-Price-Usd-${field === "prompt" ? "Prompt" : "Completion"}`] = value;
        }
      }
      const payload = JSON.stringify({ ...input.body, stream: false, verify_tee: true });
      if (Buffer.byteLength(payload) > responseLimit) denied("The private inference request exceeds the size limit.");
      return new Promise<Response>((resolve, reject) => {
        const req = request(url, {
          method: "POST", agent: false, rejectUnauthorized: true, signal: AbortSignal.timeout(input.timeoutMs),
          headers: { ...priceHeaders, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${input.apiKey}`, "X-0G-Provider-Trust-Mode": "private" },
          checkServerIdentity(host, certificate) {
            const ordinaryError = checkServerIdentity(host, certificate);
            if (ordinaryError) return ordinaryError;
            if (attestation && createHash("sha256").update(certificate.raw).digest("hex") !== attestation.certificateSha256) return new Error("The inference TLS certificate differs from the independently verified gateway certificate.");
            return undefined;
          },
        }, response => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > responseLimit) response.destroy(new Error("Private inference response exceeds the size limit.")); else chunks.push(chunk); });
          response.on("error", reject);
          response.on("end", () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
            const status = response.statusCode ?? 502;
            if (status >= 300 && status < 400) return reject(new EngineError("PRIVATE_INFERENCE_UNVERIFIED", "Private inference redirects are refused. No fallback request was made.", 502));
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
          });
        });
        req.setTimeout(input.timeoutMs, () => req.destroy(new Error("Private inference timed out.")));
        req.on("error", reject);
        req.end(payload);
      });
    },
  };
}
