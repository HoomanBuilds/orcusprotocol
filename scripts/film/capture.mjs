import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Wallet, getBytes, toUtf8String } from "ethers";
import { allowedCaptureRequest, captureOrigin, captureProvenance, concatFrames, recordedResearch } from "./capture-safety.mjs";

const args = process.argv.slice(2);
const overviewOnly = args.includes("--overview-only");
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const origin = captureOrigin(option("--origin") ?? "http://localhost:3134");
const out = option("--out"), source = option("--research-db");
assert.ok(out && isAbsolute(out) && !resolve(out).startsWith(resolve(process.cwd())), "Provide an absolute --out directory outside the checkout.");
assert.ok(source && isAbsolute(source), "Provide the local --research-db containing prior successful public research.");
const health = await fetch(new URL("/api/health", origin)).then(response => response.json());
assert.equal(health.data.compute.configured, false, "Capture must not have paid inference credentials.");
const db = new DatabaseSync(source, { readOnly: true });
const research = recordedResearch(db.prepare("SELECT body FROM records WHERE kind='message' ORDER BY created_at ASC").all());
db.close();
const directory = join(out, `run-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(directory, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "orcus-film-browser-"));
const owner = Wallet.createRandom();
const manifest = { version: 2, createdAt: new Date().toISOString(), origin: origin.origin, viewport: { width: 1536, height: 864, deviceScaleFactor: 1.25 }, output: { width: 1920, height: 1080, fps: 30 }, owner: owner.address, safety: { unfundedDisposableOwner: true, paidInferenceCalls: 0, publicTradingWrites: 0, blockedRequests: [], rejectedWalletMethods: [] }, accountModeTransitions: [], research: research.map(item => item.evidence), shots: [] };
const browser = spawn(process.env.CHROMIUM_PATH ?? "/usr/sbin/chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, rpc, recording, cursor = { x: 1460, y: 805 };
let stopping = false;
let demoMode = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
const events = [];
async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const process = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] }); let error = "";
    process.stderr.on("data", data => { error = (error + data).slice(-6000); });
    process.once("error", reject); process.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${error}`)));
  });
}
try {
  await (async () => {
  const activePort = join(profile, "DevToolsActivePort");
  for (let i = 0; !existsSync(activePort) && i < 100; i++) await delay(100);
  assert.ok(existsSync(activePort), "Chromium did not start.");
  const port = Number(readFileSync(activePort, "utf8").split("\n")[0]);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("close", () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("Capture browser closed.")); } pending.clear(); });
  rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error("Capture browser is not connected.")); return; }
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", event => {
    const value = JSON.parse(String(event.data));
    if (value.id) { const task = pending.get(value.id); if (!task) return; clearTimeout(task.timer); pending.delete(value.id); value.error ? task.reject(new Error(value.error.message)) : task.resolve(value.result); }
    if (value.method === "Fetch.requestPaused") {
      const { request, requestId } = value.params;
      const allowed = allowedCaptureRequest(request, origin.origin, demoMode);
      if (!allowed) manifest.safety.blockedRequests.push({ method: request.method, url: new URL(request.url).origin + new URL(request.url).pathname });
      void rpc(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
    if (value.method === "Page.screencastFrame") {
      if (recording) {
        const file = `frame-${String(recording.frames.length).padStart(6, "0")}.jpg`;
        writeFileSync(join(recording.path, file), Buffer.from(value.params.data, "base64"));
        recording.frames.push({ file, at: (performance.now() - recording.started) / 1000 });
      }
      void rpc("Page.screencastFrameAck", { sessionId: value.params.sessionId }).catch(() => {});
    }
    if (value.method === "Runtime.bindingCalled" && value.params.name === "__filmWallet") {
      void (async () => {
        const request = JSON.parse(value.params.payload); let result, error;
        try {
          if (["eth_accounts", "eth_requestAccounts"].includes(request.method)) result = [owner.address];
          else if (request.method === "eth_chainId") result = "0x66eee";
          else if (request.method === "wallet_switchEthereumChain") result = null;
          else if (request.method === "personal_sign") {
            assert.equal(demoMode, false, "Demo mode cannot sign a message.");
            const message = toUtf8String(request.params[0]);
            assert.equal(String(request.params[1]).toLowerCase(), owner.address.toLowerCase());
            assert.ok(message.startsWith(`${origin.host} wants you to sign in to Orcus.`) && message.includes(`URI: ${origin.origin}\n`) && message.endsWith("This signs you in only. It does not authorize trading or transfer funds."));
            result = await owner.signMessage(getBytes(request.params[0]));
          } else { manifest.safety.rejectedWalletMethods.push(request.method); throw new Error("Capture permits local login only."); }
        } catch { error = { code: 4001, message: "Only local sign-in is permitted during this recording." }; }
        await rpc("Runtime.evaluate", { expression: `window.__filmWalletReply(${JSON.stringify({ id: request.id, result, error })})` });
      })().catch(() => {});
    }
  });
  const evaluate = async expression => {
    const result = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser expression failed.");
    return result.result.value;
  };
  const until = async (expression, label) => { for (let i = 0; i < 150; i++) { try { if (await evaluate(expression)) return; } catch (error) { if (!/Execution context was destroyed|Cannot find (?:execution )?context|Inspected target navigated/i.test(String(error))) throw error; } await delay(200); } throw new Error(`State unavailable: ${label}`); };
  const overlay = async () => evaluate(`(()=>{if(!document.getElementById('film-cursor')){let c=document.createElement('div');c.id='film-cursor';c.style.cssText='position:fixed;top:0;left:0;width:20px;height:27px;pointer-events:none;z-index:2147483647;transform:translate(1460px,805px)';c.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 27"><path d="M2 2v20l5-5 4 8 4-2-4-8h7Z" fill="#171419" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';document.body.append(c)}})()`);
  const point = async (selector, text) => evaluate(`(()=>{const e=${text ? `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)})` : `document.querySelector(${JSON.stringify(selector)})`};if(!e||e.disabled)throw new Error('Control unavailable: '+${JSON.stringify(selector + (text ?? ""))});const r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)throw new Error('Control outside viewport: '+${JSON.stringify(selector)});return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const move = async target => {
    const start = { ...cursor }, duration = 600, started = performance.now();
    while (performance.now() - started < duration) {
      const t = Math.min(1, (performance.now() - started) / duration), eased = t * t * (3 - 2 * t);
      cursor = { x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased };
      await evaluate(`document.getElementById('film-cursor').style.transform='translate(${cursor.x}px,${cursor.y}px)'`);
      await delay(25);
    }
    cursor = target; await evaluate(`document.getElementById('film-cursor').style.transform='translate(${target.x}px,${target.y}px)'`);
  };
  const click = async (selector, text) => { const target = await point(selector, text); await move(target); await delay(180); await rpc("Input.dispatchMouseEvent", { type: "mousePressed", ...target, button: "left", clickCount: 1 }); await rpc("Input.dispatchMouseEvent", { type: "mouseReleased", ...target, button: "left", clickCount: 1 }); events.push({ at: Date.now(), action: "click", selector, ...(text ? { text } : {}) }); await delay(250); };
  const type = async (selector, value) => { await click(selector); await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 }); await rpc("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }); for (const character of value) { await rpc("Input.insertText", { text: character }); await delay(35); } events.push({ at: Date.now(), action: "type", selector, value }); };
  const select = async (selector, value) => { await move(await point(selector)); await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`); events.push({ at: Date.now(), action: "select", selector, value }); await delay(600); };
  const scroll = async (selector, amount) => evaluate(`new Promise(resolve=>{const e=${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.scrollingElement"};const start=e.scrollTop,end=Math.min(e.scrollHeight-e.clientHeight,Math.max(0,start+${amount})),at=performance.now();function frame(now){const t=Math.min(1,(now-at)/1000);e.scrollTop=start+(end-start)*(t*t*(3-2*t));if(t<1)requestAnimationFrame(frame);else resolve()}requestAnimationFrame(frame)})`);
  const nav = async name => { const path = name === "Overview" ? "/" : `/${name.toLowerCase()}`, selector = `.primary-nav a[href='${path}']`; if (await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top<0`)) await scroll(null, -10000); await click(selector); await until(`location.pathname===${JSON.stringify(path)}`, name); await delay(700); };
  const api = async (path, body) => evaluate(`fetch(${JSON.stringify(path)},{method:${body ? "'POST'" : "'GET'"},headers:{'Content-Type':'application/json'},${body ? `body:${JSON.stringify(JSON.stringify(body))},` : ""}credentials:'same-origin'}).then(async r=>({status:r.status,body:await r.json()}))`);
  const demoBadge = "span[aria-label='Demo account, sample data only']";
  const assertDemoVisible = async () => assert.ok(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(demoBadge)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})()`), "The native Demo account badge must remain visible with sample data.");
  const changeAccountMode = async entering => {
    const previousDocument = await evaluate("performance.timeOrigin");
    if (entering) demoMode = true;
    await click(entering ? "button[aria-label='Explore demo account']" : "button[aria-label='Exit demo account']");
    await until(`performance.timeOrigin!==${previousDocument}&&document.readyState==='complete'&&${entering ? `!!document.querySelector(${JSON.stringify(demoBadge)})` : `!document.querySelector(${JSON.stringify(demoBadge)})&&!!document.querySelector('.wallet-button')`}`, entering ? "Reloaded Demo account" : "Restored real wallet session");
    await evaluate("document.fonts.ready");
    await overlay();
    demoMode = entering;
    if (entering) await assertDemoVisible();
    manifest.accountModeTransitions.push({ at: Date.now(), mode: entering ? "browser-local-demo" : "real-unfunded-wallet", visibleButtonClicked: true, pageReloadObserved: true });
    await delay(1000);
  };
  const shot = async (id, seconds, label, actions) => {
    if (overviewOnly) { await overlay(); await actions(); return; }
    if (stopping) throw new Error("Capture stopped between shots; completed clips are preserved.");
    await overlay(label); await delay(350);
    const path = join(directory, id); mkdirSync(path);
    const first = await rpc("Page.captureScreenshot", { format: "jpeg", quality: 92, captureBeyondViewport: false });
    writeFileSync(join(path, "frame-000000.jpg"), Buffer.from(first.data, "base64"));
    recording = { path, started: performance.now(), startedAt: Date.now(), frames: [{ file: "frame-000000.jpg", at: 0 }] };
    const actionStart = events.length;
    await rpc("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    await delay(1500); await actions();
    await move({ x: 1460, y: 805 });
    await delay(Math.max(2200, seconds * 1000 - (performance.now() - recording.started)));
    await rpc("Page.stopScreencast");
    const duration = (performance.now() - recording.started) / 1000, captured = recording; recording = undefined;
    writeFileSync(join(path, "frames.txt"), concatFrames(captured.frames, duration));
    const output = join(directory, `${id}.mp4`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "1", "-i", "frames.txt", "-vf", "scale=1920:1080:flags=lanczos,fps=30", "-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p", "-an", output], path);
    const screenshot = await rpc("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(directory, `${id}-end.png`), Buffer.from(screenshot.data, "base64"));
    if (demoMode) await assertDemoVisible();
    manifest.shots.push({ id, file: output, duration, startedAt: captured.startedAt, frames: captured.frames.length, provenance: captureProvenance(id), disclosure: label, disclosureDelivery: "manifest-and-native-product-status", actions: events.slice(actionStart) });
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ shot: id, duration, file: output }));
  };
  await rpc("Runtime.enable"); await rpc("Page.enable"); await rpc("Network.enable"); await rpc("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await rpc("Emulation.setDeviceMetricsOverride", { ...manifest.viewport, mobile: false });
  await rpc("Runtime.addBinding", { name: "__filmWallet" });
  await rpc("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{let id=0;const pending=new Map();window.__filmWalletReply=r=>{const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(r.error):p.resolve(r.result)};window.ethereum={request:r=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});window.__filmWallet(JSON.stringify({id:key,...r}))}),on:()=>{},removeListener:()=>{}}})()` });
  await rpc("Page.navigate", { url: new URL("/landing", origin).href });
  await until("document.readyState==='complete'&&!!document.querySelector('video')", "Landing hero");
  await evaluate("document.fonts.ready"); await delay(1800);
  if (!overviewOnly) await shot("01-landing", 10, "Testnet product walkthrough | No trades submitted", async () => { await move({ x: 950, y: 670 }); await delay(4500); });
  await rpc("Page.navigate", { url: origin.href });
  await until("!!document.querySelector('.connect-button')&&Object.keys(document.querySelector('.connect-button')).some(k=>k.startsWith('__reactProps'))", "Application hydration");
  let account;
  await shot("02-onboarding", 18, "Actual local sign-in followed by explicit browser-local Demo account | Sample balances are not real funds", async () => {
    await click(".connect-button"); await until("!!document.querySelector('.wallet-button')", "Signed session");
    await nav("Settings"); await click(".account-add-buttons button", "Hyperliquid"); await until("!!document.querySelector('.account-card')", "Hyperliquid account");
    const session = (await api("/api/session")).body.data;
    assert.equal(session.user.address.toLowerCase(), owner.address.toLowerCase());
    account = session.accounts.find(item => item.venue === "hyperliquid"); assert.ok(account);
    await nav("Overview"); await changeAccountMode(true);
    await until("!!document.getElementById('overview-accounts')", "Connected account overview");
    const overview = await rpc("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(directory, "overview-demo-top.png"), Buffer.from(overview.data, "base64"));
    await assertDemoVisible(); await delay(2800);
  });
  if (overviewOnly) { console.log(JSON.stringify({ overview: directory, publicTradingWrites: 0 })); return; }
  await nav("Trade"); await until("document.querySelector('.market-price strong')?.textContent.startsWith('$')", "Readonly market price");
  await assertDemoVisible();
  await shot("03-hyperliquid", 22, "Demo account: sample positions and history | Read-only venue market feed | No order submitted", async () => {
    await click(".market-select"); await type("input[aria-label='Search markets']", "ETH"); await click(".market-options-list button");
    await until("document.querySelector('.market-select strong')?.textContent==='ETH'", "ETH market"); await delay(3500);
    await click(".order-type-tabs button", "Limit"); await type("input[aria-label='Order amount']", "0.001"); await delay(2200);
    await click(".market-select"); await type("input[aria-label='Search markets']", "BTC"); await click(".market-options-list button"); await until("document.querySelector('.market-select strong')?.textContent==='BTC'", "BTC market"); await delay(2200);
  });
  await shot("04-uniswap", 14, "Demo account: sample balances | Uniswap Sepolia swap inputs | No quote or swap submitted", async () => {
    await select("select[aria-label='Trading venue']", "uniswap"); await until("document.body.innerText.includes('Swap tokens')&&document.querySelector('.market-select strong')?.textContent==='WETH/USDC'", "Loaded WETH/USDC swap controls"); await delay(1500); await click(".side-toggle button", "Sell"); await type("input[aria-label='Order amount']", "0.01"); await delay(2500);
    await assertDemoVisible(); await changeAccountMode(false);
  });
  const restoredSession = (await api("/api/session")).body.data;
  assert.equal(restoredSession.user.address.toLowerCase(), owner.address.toLowerCase());
  assert.ok(restoredSession.accounts.some(item => item.id === account.id));
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(demoBadge)})`), false);
  await evaluate(`(()=>{const original=window.fetch.bind(window);window.__filmOriginalFetch=original;window.__filmResearchPlayback=true;window.fetch=async(input,options={})=>{const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;const response=await original(input,options);if(window.__filmResearchPlayback&&path==='/api/agent'&&(!options.method||options.method==='GET')){const body=await response.json();body.data.messages=${JSON.stringify(research[0].messages)};return new Response(JSON.stringify(body),{status:response.status,headers:{'Content-Type':'application/json'}})}return response}})()`);
  await nav("Agent"); await click("button[aria-label='Refresh accounts']"); await until("document.body.innerText.includes('Based on the Hyperliquid testnet observation')", "Recorded research restored");
  await evaluate("document.querySelector('.chat-scroll').scrollTop=0");
  await shot("05-research", 14, "Recorded 0G research | Original testnet observations | Not a live generation", async () => {
    await delay(1200); await click("button[aria-controls='agent-context']"); await delay(1400); await click("button[aria-label='Close agent context']");
    await click(".agent-tool-activity summary"); await delay(1200); await scroll(".chat-scroll", 150);
    await click(".chat-message.assistant .message-evidence summary"); await delay(900); await scroll(".chat-scroll", 90); await delay(3200);
    assert.ok(await evaluate("(()=>{const r=document.querySelector('.chat-message.assistant .agent-response').getBoundingClientRect(),s=document.querySelector('.chat-scroll').getBoundingClientRect();return r.top>=s.top&&r.bottom<=s.bottom})()"), "Recorded answer must remain completely readable.");
  });
  await evaluate("window.__filmResearchPlayback=false");
  await nav("Trade"); await select("select[aria-label='Trading venue']", "hyperliquid"); await nav("Automations");
  await shot("06-strategy", 16, "Actual strategy review | Not activated | No trading authority granted", async () => {
    await click(".automation-starter.strategy");
    await until("!!document.querySelector('.automation-form')", "Rule form");
    await type("input[placeholder='My ETH rule']", "Bounded ETH entry");
    const fields = { "Base asset amount per submission": "0.001", "Threshold": "2000" };
    for (const [label, value] of Object.entries(fields)) {
      const id = `film-field-${label.startsWith("Threshold") ? "threshold" : "amount"}`;
      await evaluate(`(()=>{const label=[...document.querySelectorAll('.automation-form label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)}));if(!label)throw new Error('Missing form field');label.querySelector('input').id=${JSON.stringify(id)}})()`);
      await type(`#${id}`, value);
    }
    await scroll(null, 460); await delay(1800); await click(".form-actions button", "Review rule");
    await until("document.body.innerText.includes('Your exact execution policy')", "Explicit policy review");
    await evaluate("document.querySelector('.automation-form').scrollIntoView({block:'start',behavior:'instant'})"); await delay(3000);
    assert.ok(await evaluate("[...document.querySelectorAll('.form-actions button')].find(e=>e.textContent.trim()==='Approve and activate').disabled"));
  });
  const queued = await api("/api/agent/requests", { requestId: randomUUID(), message: "Review my account exposure. Research only; do not trade.", accountId: account.id, autonomous: false });
  assert.equal(queued.status, 202); assert.equal(queued.body.data.request.status, "queued");
  manifest.queueEvidence = { requestId: queued.body.data.request.id, status: "queued", paidInferencePerformed: false };
  await nav("Activity"); await click("button[aria-label='Refresh accounts']"); await until("document.body.innerText.includes('Agent instruction')", "Durable instruction history");
  await shot("07-control-history", 17, "Saved local instruction: queued | No worker or paid inference | Owner controls", async () => {
    await delay(3500); await nav("Agent"); await until("!!document.querySelector('button[aria-label=\"Pause agent\"]')", "Owner pause control"); await click("button[aria-label='Pause agent']"); await until("!!document.querySelector('button[aria-label=\"Resume agent\"]')", "Paused state");
    await click("button[aria-controls='agent-context']"); await delay(2000); await click(".agent-context-panel button", "Take over accounts"); await delay(2000);
  });
  assert.equal(manifest.safety.rejectedWalletMethods.length, 0, "Unexpected signing attempt occurred.");
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ manifest: join(directory, "manifest.json"), shots: manifest.shots.length, duration: manifest.shots.reduce((sum, shot) => sum + shot.duration, 0) }));
  })();
} finally {
  recording = undefined;
  await rpc?.("Browser.close").catch(() => {}); socket?.close(); browser.kill("SIGTERM");
  await new Promise(resolve => { if (browser.exitCode !== null) resolve(); else { browser.once("exit", resolve); setTimeout(resolve, 3000); } });
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
