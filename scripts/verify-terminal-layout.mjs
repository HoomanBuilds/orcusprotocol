import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const origin = new URL(process.argv[2] ?? "http://localhost:3134");
const output = process.argv[3];
assert.ok(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && origin.port === "3134" && !origin.username && !origin.password, "Use the isolated local preview on port 3134.");
assert.ok(output && isAbsolute(output) && !resolve(output).startsWith(`${process.cwd()}/`), "Pass an absolute screenshot directory outside the repository.");
const health = await fetch(new URL("/api/health", origin)).then(response => response.json());
assert.equal(health.data.compute.configured, false, "Use a preview without inference credentials.");
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "orcus-terminal-review-"));
const browser = spawn(process.env.CHROMIUM_PATH ?? "/usr/sbin/chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [], blockedWrites = [];
let socket, rpc;
try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; !existsSync(portFile) && i < 100; i++) await delay(100);
  assert.ok(existsSync(portFile), "Chromium did not start.");
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    }
    if (message.method === "Fetch.requestPaused") {
      const { request, requestId } = message.params;
      const allowed = ["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (!allowed) blockedWrites.push({ method: request.method, url: new URL(request.url).pathname });
      void rpc(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  });
  const evaluate = async expression => {
    const result = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
    return result.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`UI state not ready: ${expression}`);
  };
  const screenshot = async name => {
    await evaluate("document.fonts.ready"); await delay(350);
    assert.ok(!await evaluate("!!document.querySelector('nextjs-portal')"), "Use a production preview.");
    const image = await rpc("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(output, `${name}.png`), Buffer.from(image.data, "base64"));
  };
  const geometry = () => evaluate(`(()=>{
    const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{top:r.top,bottom:r.bottom,width:r.width,height:r.height,radius:c.borderTopLeftRadius,display:c.display}};
    const select=document.querySelector('select[aria-label="Trading venue"]'),option=select?.options[0];
    return {overflow:document.documentElement.scrollWidth>innerWidth,chart:rect('.chart-panel'),canvas:rect('.chart-canvas'),market:rect('.trade-market-grid'),tables:rect('.trade-tables-row'),ticket:rect('.order-ticket'),depth:rect('.trade-depth-column > section'),brandImage:!!document.querySelector('.workspace-brand img'),select:select?{scheme:getComputedStyle(select).colorScheme,background:getComputedStyle(option).backgroundColor,color:getComputedStyle(option).color}:null};
  })()`);
  await rpc("Page.enable"); await rpc("Runtime.enable");
  await rpc("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  for (const viewport of [{ name: "desktop", width: 1536, height: 864 }, { name: "laptop", width: 1366, height: 768 }, { name: "mobile", width: 390, height: 844 }]) {
    await rpc("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === "mobile" });
    await rpc("Page.navigate", { url: new URL("/trade", origin).href });
    await until("!!document.querySelector('.trade-market-grid') && Object.keys(document.querySelector('.trade-venue-select select')).some(k=>k.startsWith('__reactProps'))");
    for (let i = 0; i < 40 && await evaluate("!!document.querySelector('.chart-loading')"); i++) await delay(200);
    const hyperliquid = await geometry();
    assert.equal(hyperliquid.overflow, false); assert.equal(hyperliquid.brandImage, false);
    assert.equal(hyperliquid.chart.radius, "0px"); assert.ok(hyperliquid.canvas.height > 150);
    assert.equal(hyperliquid.select.scheme, "dark"); assert.notEqual(hyperliquid.select.background, "rgb(255, 255, 255)");
    if (viewport.name !== "mobile") {
      assert.ok(Math.abs(hyperliquid.chart.bottom - hyperliquid.market.bottom) <= 1, "Chart must fill the complete market row.");
      assert.ok(Math.abs(hyperliquid.chart.bottom - hyperliquid.tables.top) <= 1, "Account tables must directly follow the chart.");
      assert.equal(hyperliquid.ticket.radius, "0px"); assert.equal(hyperliquid.depth.radius, "0px");
    }
    await screenshot(`${viewport.name}-hyperliquid`);
    if (viewport.name === "mobile") {
      for (const label of ["Depth", "Ticket", "Accounts", "Chart"]) {
        await evaluate(`([...document.querySelectorAll('.trade-mobile-tabs button')].find(e=>e.textContent===${JSON.stringify(label)})).click()`);
        await delay(200); assert.equal((await geometry()).overflow, false);
        if (label !== "Chart") await screenshot(`mobile-hyperliquid-${label.toLowerCase()}`);
      }
    }
    await evaluate("(()=>{const e=document.querySelector('.trade-venue-select select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'uniswap');e.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await until("!!document.querySelector('[data-venue=uniswap]')"); await delay(600);
    const uniswap = await geometry();
    assert.equal(uniswap.chart, null); assert.equal(uniswap.overflow, false); assert.ok(uniswap.depth.height > 0);
    await screenshot(`${viewport.name}-uniswap`);
    await rpc("Page.navigate", { url: origin.href }); await until("document.querySelector('h1')?.textContent==='Overview'");
    const overview = await geometry(); assert.equal(overview.overflow, false); assert.equal(overview.brandImage, false);
    await screenshot(`${viewport.name}-overview`);
    results.push({ viewport, hyperliquid, uniswap, overview });
  }
  assert.equal(blockedWrites.length, 0, "Unexpected write request during read-only layout review.");
  writeFileSync(join(output, "layout-verification.json"), JSON.stringify({ results, blockedWrites }, null, 2));
  console.log(JSON.stringify({ passed: true, viewports: results.length, output }));
} finally {
  await rpc?.("Browser.close").catch(() => {}); socket?.close(); browser.kill("SIGTERM");
  await new Promise(resolve => { if (browser.exitCode !== null) resolve(); else { browser.once("exit", resolve); setTimeout(resolve, 3000); } });
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
