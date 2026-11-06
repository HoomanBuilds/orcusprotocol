import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const origin = new URL(process.argv[2] ?? "http://localhost:3134"), output = process.argv[3];
assert.ok(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname) && origin.port === "3134");
assert.ok(output && isAbsolute(output) && !output.startsWith(process.cwd()));
assert.equal((await fetch(new URL("/api/health", origin)).then(r => r.json())).data.compute.configured, false);
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "orcus-demo-review-"));
const browser = spawn(process.env.CHROMIUM_PATH ?? "/usr/sbin/chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const writes = [], privateReads = [], publicReads = [], screenshots = [];
let socket, rpc, demoActive = false;
try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; !existsSync(portFile) && i < 100; i++) await delay(100);
  assert.ok(existsSync(portFile));
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser closed")); } pending.clear(); });
  rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error("Browser is not connected")); return; }
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.id) { const item = pending.get(message.id); if (!item) return; clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params, url = new URL(request.url);
      const publicRead = ["/api/health", "/api/markets", "/api/candles", "/api/market-context"].includes(url.pathname);
      let allowed = ["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (!allowed) writes.push({ method: request.method, path: url.pathname });
      if (demoActive && url.origin === origin.origin && url.pathname.startsWith("/api/")) {
        if (publicRead) publicReads.push(url.pathname);
        else { privateReads.push(url.pathname); allowed = false; }
      }
      void rpc(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  });
  const evaluate = async expression => { const r = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "Evaluation failed"); return r.result.value; };
  const until = async expression => { for (let i = 0; i < 120; i++) { try { if (await evaluate(expression)) return; } catch {} await delay(100); } throw new Error(`State unavailable: ${expression}`); };
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getBoundingClientRect().width>0);if(!e||e.disabled)throw Error('Unavailable control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)throw Error('Hidden control');return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await rpc("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await rpc("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  const screenshot = async name => {
    await evaluate("document.fonts.ready"); await delay(300);
    assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false, `${name} overflows horizontally`);
    const shot = await rpc("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const path = join(output, `${name}.png`); writeFileSync(path, Buffer.from(shot.data, "base64")); screenshots.push(path);
  };
  const navigate = async path => { await rpc("Page.navigate", { url: new URL(path, origin).href }); await until("document.body.innerText.includes('Demo account')&&!!document.querySelector('.wallet-button')"); await delay(400); };
  await rpc("Page.enable"); await rpc("Runtime.enable");
  await rpc("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await rpc("Emulation.setDeviceMetricsOverride", { width: 1536, height: 864, deviceScaleFactor: 1, mobile: false });
  await rpc("Page.navigate", { url: origin.href });
  await until("!!document.querySelector('[aria-label=\"Explore demo account\"]')&&Object.keys(document.querySelector('[aria-label=\"Explore demo account\"]')).some(k=>k.startsWith('__reactProps'))");
  demoActive = true;
  await click("button[aria-label='Explore demo account']");
  await until("document.body.innerText.includes('Demo account')&&document.body.innerText.includes('$23,340.20')");
  await until("document.querySelectorAll('.overview-market-cards > button').length>0");
  await screenshot("desktop-overview");
  await evaluate("document.getElementById('overview-accounts').scrollIntoView({block:'start'})"); await screenshot("desktop-accounts");
  await rpc("Page.reload"); await until("document.body.innerText.includes('$23,340.20')&&document.body.innerText.includes('Demo account')");
  const routes = [["trade", "/trade"], ["agent", "/agent"], ["automations", "/automations"], ["activity", "/activity"], ["settings", "/settings"]];
  for (const [name, path] of routes) {
    await navigate(path);
    if (name === "trade") await until("document.querySelector('.market-price strong')?.textContent.startsWith('$')&&!document.querySelector('.chart-loading')");
    if (name === "agent") {
      await until("document.body.innerText.includes('fixed demo values')");
      await click("button[aria-label='Pause agent']");
      await until("document.body.innerText.includes('Demo account is read-only')");
      await click("button[aria-label='Dismiss error']").catch(() => {});
    }
    await screenshot(`desktop-${name}`);
  }
  await rpc("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const [name, path] of [["overview", "/"], ...routes]) { await navigate(path); await screenshot(`mobile-${name}`); }
  await navigate("/");
  await click("details summary.wallet-button"); await screenshot("mobile-account-menu");
  demoActive = false;
  await evaluate("[...document.querySelectorAll('details button')].find(e=>e.textContent==='Exit demo').click()");
  await until("!document.body.innerText.includes('Demo account')&&document.body.innerText.includes('All your accounts.')");
  assert.equal(await evaluate("localStorage.getItem('orcus:demo-account:v1')"), null);
  assert.equal(await evaluate("document.body.innerText.includes('$23,340.20')"), false);
  await screenshot("mobile-exit");
  assert.equal(writes.length, 0, "A mutation reached the network");
  assert.equal(privateReads.length, 0, "Demo fetched real private account data");
  assert.ok(publicReads.includes("/api/markets"), "Public markets must remain live");
  writeFileSync(join(output, "demo-verification.json"), JSON.stringify({ passed: true, writes, privateReads, publicReads: [...new Set(publicReads)], screenshots }, null, 2));
  console.log(JSON.stringify({ passed: true, screenshots: screenshots.length, output }));
} finally {
  await rpc?.("Browser.close").catch(() => {}); socket?.close(); browser.kill("SIGTERM");
  await new Promise(resolve => { if (browser.exitCode !== null || browser.signalCode !== null) resolve(); else { const timer = setTimeout(resolve, 3000); browser.once("exit", () => { clearTimeout(timer); resolve(); }); } });
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { console.warn(`Retained busy browser profile: ${profile}`); }
}
