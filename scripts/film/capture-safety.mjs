import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function captureOrigin(value) {
  const url = new URL(value);
  assert.ok(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === "3134" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password, "Capture requires the isolated local server on port3134.");
  return url;
}

export function allowedCaptureRequest(request, origin) {
  const url = new URL(request.url), method = request.method.toUpperCase();
  if (url.origin !== origin) return method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "POST" && url.origin === "https://api.hyperliquid-testnet.xyz" && url.pathname === "/info";
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  if (method !== "POST") return false;
  let body;
  try { body = JSON.parse(request.postData ?? "{}"); } catch { return false; }
  if (["/api/auth/challenge", "/api/auth/verify", "/api/auth/logout"].includes(url.pathname)) return true;
  if (url.pathname === "/api/accounts") return ["hyperliquid", "uniswap"].includes(body.venue);
  if (url.pathname === "/api/agent/control") return ["pause", "resume", "take-over"].includes(body.command);
  if (url.pathname === "/api/agent/requests") return body.autonomous === false && body.message === "Review my account exposure. Research only; do not trade.";
  return false;
}

export function recordedResearch(rows) {
  const messages = rows.map(row => ({ message: JSON.parse(row.body), hash: createHash("sha256").update(row.body).digest("hex") }));
  const names = ["read_markets", "analyze_market", "read_market_context"];
  const selected = names.map(name => messages.find(({ message }) => message.role === "assistant" && !message.proposedAction && !message.automationProposal && !message.content.startsWith("I could not verify") && message.toolSteps?.some(step => step.name === name && step.ok && step.sources?.length)));
  assert.ok(selected.every(Boolean), "The recording requires successful stored market, candle and funding research.");
  const clean = message => ({ id: message.id, role: message.role, content: message.content, createdAt: message.createdAt, ...(message.requestId ? { requestId: message.requestId } : {}), ...(message.modelId ? { modelId: message.modelId } : {}), ...(message.toolSteps ? { toolSteps: message.toolSteps.map(step => ({ name: step.name, ok: step.ok, observedAt: step.observedAt, ...(step.sources ? { sources: step.sources.map(source => { const url = new URL(source.url); assert.ok(url.protocol === "https:" && !url.username && !url.password); return { id: source.id, title: source.title, url: url.href, retrievedAt: source.retrievedAt, ...(source.network ? { network: source.network } : {}) }; }) } : {}) })) } : {}) });
  return selected.map(({ message, hash }) => {
    const user = messages.find(item => item.message.id === message.id.replace(/:assistant$/, ":user"));
    assert.ok(user?.message.role === "user");
    return { messages: [clean(user.message), clean(message)], evidence: { sourceRecordId: message.id, sourceBodySha256: hash, recordedAt: message.createdAt, requestId: message.requestId, modelId: message.modelId, tools: message.toolSteps.filter(step => step.ok).map(step => step.name) } };
  });
}

export function concatFrames(frames, duration) {
  assert.ok(frames.length && duration > 0);
  return frames.map((frame, index) => {
    assert.match(frame.file, /^frame-\d{6}\.jpg$/);
    const end = index + 1 < frames.length ? frames[index + 1].at : duration;
    return `file '${frame.file}'\nduration ${Math.max(1 / 120, end - frame.at).toFixed(6)}`;
  }).join("\n") + `\nfile '${frames.at(-1).file}'\n`;
}
