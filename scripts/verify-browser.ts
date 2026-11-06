import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, getBytes } from "ethers";

const origin = new URL(process.argv[2] ?? "http://localhost:3124");
assert.ok(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && !origin.username && !origin.password, "Only a local isolated application is allowed.");
const health = await fetch(new URL("/api/health", origin)).then(response => response.json());
assert.equal(health.data.compute.configured, false, "Use an isolated app without inference credentials for this browser proof.");
const profile = mkdtempSync(join(tmpdir(), "orcus-browser-proof-"));
const browser = spawn(process.env.CHROMIUM_PATH ?? "/usr/sbin/chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let socket: WebSocket | undefined;
const checks: string[] = [];
try {
  const activePort = join(profile, "DevToolsActivePort");
  for (let attempt = 0; !existsSync(activePort) && attempt < 100; attempt++) await delay(100);
  assert.ok(existsSync(activePort), "Chromium did not start.");
  const port = Number(readFileSync(activePort, "utf8").split("\n")[0]);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  socket = new WebSocket(targets.find(target => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("Browser connection failed.")), { once: true }); });
  let sequence = 0, ownerIndex = 0, rejectLogin = false, tradeSignatureAttempts = 0, exchangeRequests = 0, controlRequests = 0;
  let holdNextOwnerRead = false, releaseOwnerRead: (() => void) | undefined;
  const owners = [Wallet.createRandom(), Wallet.createRandom()];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const rpc = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 30_000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); });
  socket.addEventListener("message", event => {
    const value = JSON.parse(String(event.data));
    if (value.id) { const task = pending.get(value.id); pending.delete(value.id); clearTimeout(task?.timer); if (value.error) task?.reject(new Error(value.error.message)); else task?.resolve(value.result); }
    if (value.method === "Network.requestWillBeSent") { const request = value.params.request; if (request.url.includes("hyperliquid-testnet.xyz/exchange")) exchangeRequests++; if (request.url === new URL("/api/agent/control", origin).href && request.method === "POST") controlRequests++; }
    if (value.method === "Runtime.bindingCalled" && value.params.name === "__orcusWalletBinding") {
      void (async () => {
        const request = JSON.parse(value.params.payload); let result: unknown, error: unknown;
        try {
          if (["eth_accounts", "eth_requestAccounts"].includes(request.method)) {
            if (request.method === "eth_accounts" && holdNextOwnerRead) { holdNextOwnerRead = false; await new Promise<void>(resolve => { releaseOwnerRead = resolve; }); }
            result = [owners[ownerIndex].address];
          }
          else if (request.method === "eth_chainId") result = "0x66eee";
          else if (request.method === "wallet_switchEthereumChain") result = null;
          else if (request.method === "personal_sign") {
            if (rejectLogin) throw Object.assign(new Error("User rejected request"), { code: 4001 });
            assert.equal(String(request.params[1]).toLowerCase(), owners[ownerIndex].address.toLowerCase());
            result = await owners[ownerIndex].signMessage(getBytes(request.params[0]));
          } else { tradeSignatureAttempts++; throw Object.assign(new Error("User rejected trade signature"), { code: 4001 }); }
        } catch (cause) { error = { code: (cause as { code?: unknown }).code ?? 4001, message: "The disposable test wallet rejected this request." }; }
        await rpc("Runtime.evaluate", { expression: `window.__orcusWalletReply(${JSON.stringify({ id: request.id, result, error })})` });
      })().catch(() => undefined);
    }
  });
  const evaluate = async (expression: string) => {
    const result = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
    return result.result.value;
  };
  const until = async (expression: string, message: string) => { for (let attempt = 0; attempt < 150; attempt++) { if (await evaluate(expression)) return; await delay(200); } throw new Error(`${message} ${await evaluate("[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent).join(' ')")}`); };
  const click = async (selector: string) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Action unavailable');e.click();})()`);
  const navigate = async (label: string) => evaluate(`(()=>{const e=[...document.querySelectorAll('.primary-nav button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw new Error('Navigation unavailable');e.click();})()`);
  const api = async (path: string, body?: unknown, method = body ? "POST" : "GET") => evaluate(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},${body ? `body:${JSON.stringify(JSON.stringify(body))},` : ""}credentials:'same-origin'}).then(async r=>({status:r.status,body:await r.json()}))`);
  await rpc("Runtime.enable"); await rpc("Page.enable"); await rpc("Network.enable");
  await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await rpc("Runtime.addBinding", { name: "__orcusWalletBinding" });
  await rpc("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{let id=0;const pending=new Map(),listeners=new Map();window.__orcusWalletReply=r=>{const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(r.error):p.resolve(r.result)};window.__orcusWalletChanged=()=>{for(const fn of listeners.get('accountsChanged')??[])fn([])};window.ethereum={request:r=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});window.__orcusWalletBinding(JSON.stringify({id:key,...r}))}),on:(name,fn)=>listeners.set(name,[...(listeners.get(name)??[]),fn]),removeListener:(name,fn)=>listeners.set(name,(listeners.get(name)??[]).filter(x=>x!==fn))};})()` });
  await rpc("Page.navigate", { url: origin.href });
  await until("!!document.querySelector('.connect-button')", "The local application did not render.");
  await until("Object.keys(document.querySelector('.connect-button')).some(key=>key.startsWith('__reactProps'))&&typeof window.ethereum?.request==='function'", "The browser application did not hydrate.");
  rejectLogin = true; await click(".connect-button");
  await until("document.body.innerText.includes('Cancelled in your wallet')", "Wallet rejection was not translated.");
  assert.equal((await api("/api/session")).body.data.user, null); checks.push("rejected wallet signature creates no session");
  rejectLogin = false; await click(".connect-button");
  await until("!!document.querySelector('.wallet-button')", "Signed owner session did not load.");
  assert.equal((await api("/api/session")).body.data.user.address.toLowerCase(), owners[0].address.toLowerCase());
  await navigate("Settings"); await click(".account-add-buttons button");
  await until("!!document.querySelector('.account-card')", "The owned trading account did not load.");
  const account = (await api("/api/session")).body.data.accounts[0];
  assert.equal(account.address.toLowerCase(), owners[0].address.toLowerCase()); checks.push("actual signed HTTP login and owned Hyperliquid account registration");
  await navigate("Trade");
  await until("document.body.innerText.includes('Agent operating wallet')", "Distinct wallet roles were not rendered.");
  assert.ok(await evaluate("document.body.innerText.includes('Owner wallet')&&document.body.innerText.includes('Hyperliquid trading account')")); checks.push("owner, shared trading and operating wallet roles remain distinct");
  const before = controlRequests;
  await evaluate("(()=>{const e=document.querySelector('button[aria-label=\"Pause agent\"]');e.click();e.click()})()");
  await until("!!document.querySelector('button[aria-label=\"Resume agent\"]')", "The paused agent state did not load.");
  assert.equal(controlRequests - before, 1); checks.push("rapid double pause sends one request; owner trading controls remain available");
  await click("button[aria-label=\"Resume agent\"]");
  await until("!!document.querySelector('button[aria-label=\"Pause agent\"]')", "Agent resume did not load.");
  const created = await api("/api/automations", { kind: "alert", name: "Browser expiry proof", accountId: account.id, intervalSeconds: 60, condition: { symbol: "ETH", operator: "above", price: "1" }, expiresAt: Date.now() + 1500 });
  assert.equal(created.status, 201);
  await delay(1800); await click("button[aria-label=\"Refresh accounts\"]"); await navigate("Automations");
  await until("!!document.querySelector('button[aria-label=\"Automation expired\"]:disabled')", "Expired automation incorrectly offers resume.");
  const automationId = created.body.data.id ?? created.body.data.automation?.id;
  assert.equal((await api(`/api/automations/${automationId}`, { status: "active" }, "PATCH")).status, 409); checks.push("expired automation is disabled in browser and rejected by actual HTTP API");
  await navigate("Trade");
  await evaluate("(()=>{const e=document.querySelector('textarea[aria-label=\"Message your agent\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'private-owner-one-draft');e.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await until("!document.querySelector('button[aria-label=\"Refresh accounts\"]').disabled", "An earlier refresh did not finish.");
  holdNextOwnerRead = true; await click("button[aria-label=\"Refresh accounts\"]");
  for (let attempt = 0; !releaseOwnerRead && attempt < 50; attempt++) await delay(100);
  assert.ok(releaseOwnerRead, "The old owner refresh was not held for the race test.");
  ownerIndex = 1; await evaluate("window.__orcusWalletChanged()");
  await until("!!document.querySelector('.connect-button')", "Wallet change did not clear the authenticated workspace.");
  assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"Message your agent\"]').value"), "");
  await until("fetch('/api/session').then(r=>r.json()).then(r=>r.data.user===null)", "The old HTTP session was not cleared.");
  await click(".connect-button"); await until("!!document.querySelector('.wallet-button')", "The second owner could not sign in.");
  releaseOwnerRead(); await delay(1000);
  const second = (await api("/api/session")).body.data;
  assert.equal(second.user.address.toLowerCase(), owners[1].address.toLowerCase()); assert.equal(second.accounts.length, 0);
  checks.push("wallet switch clears private drafts, old session and cross-owner trading accounts");
  checks.push("a delayed old-owner refresh cannot clear or log out the newly signed-in owner");
  assert.equal(exchangeRequests, 0); assert.equal(tradeSignatureAttempts, 0);
  console.log(JSON.stringify({ scope: "local Chromium with injected disposable wallet and real HTTP/SQLite", checks, publicTradingWrites: 0, paidInferenceCalls: 0, notProven: ["real browser-extension behavior", "funded or public venue execution", "sponsor deployment"] }, null, 2));
} finally {
  socket?.close(); browser.kill("SIGTERM");
  await new Promise(resolve => { if (browser.exitCode !== null) resolve(undefined); else { browser.once("exit", resolve); setTimeout(resolve, 3000); } });
  rmSync(profile, { recursive: true, force: true });
}
