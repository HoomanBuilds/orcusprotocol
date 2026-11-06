import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let closeBrowser: (() => Promise<unknown>) | undefined;
const checks: string[] = [];
const fixtureChecks: string[] = [];
const agentFixtures = process.env.ORCUS_BROWSER_AGENT_FIXTURES === "1";
try {
  const activePort = join(profile, "DevToolsActivePort");
  for (let attempt = 0; !existsSync(activePort) && attempt < 100; attempt++) await delay(100);
  assert.ok(existsSync(activePort), "Chromium did not start.");
  const port = Number(readFileSync(activePort, "utf8").split("\n")[0]);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  socket = new WebSocket(targets.find(target => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("Browser connection failed.")), { once: true }); });
  let sequence = 0, ownerIndex = 0, rejectLogin = false, tradeSignatureAttempts = 0, exchangeRequests = 0, controlRequests = 0, agentPosts = 0;
  let holdNextOwnerRead = false, releaseOwnerRead: (() => void) | undefined;
  const owners = [Wallet.createRandom(), Wallet.createRandom()];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const rpc = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 30_000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); });
  closeBrowser = () => rpc("Browser.close");
  socket.addEventListener("message", event => {
    const value = JSON.parse(String(event.data));
    if (value.id) { const task = pending.get(value.id); pending.delete(value.id); clearTimeout(task?.timer); if (value.error) task?.reject(new Error(value.error.message)); else task?.resolve(value.result); }
    if (value.method === "Network.requestWillBeSent") { const request = value.params.request; if (request.url.includes("hyperliquid-testnet.xyz/exchange")) exchangeRequests++; if (request.url === new URL("/api/agent/control", origin).href && request.method === "POST") controlRequests++; if (request.url === new URL("/api/agent/requests", origin).href && request.method === "POST") agentPosts++; }
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
  const clickText = async (selector: string, text: string) => evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw new Error('Action unavailable');e.click();})()`);
  const visibleInChat = async (selector: string) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),scroll=document.querySelector('.chat-scroll');if(!e||!scroll)return false;const r=e.getBoundingClientRect(),s=scroll.getBoundingClientRect();return r.top>=Math.max(0,s.top)-1&&r.bottom<=Math.min(innerHeight,s.bottom)+1&&r.left>=0&&r.right<=innerWidth;})()`);
  const navigate = async (label: string) => {
    const path = label === "Overview" ? "/" : `/${label.toLowerCase()}`;
    await evaluate(`(()=>{const mobile=innerWidth<=760;if(mobile&&document.querySelector('#mobile-workspace-navigation').hidden)document.querySelector('.workspace-menu-toggle').click();const e=[...document.querySelectorAll(mobile?'#mobile-workspace-navigation a':'.primary-nav a')].find(e=>e.getAttribute('href')===${JSON.stringify(path)});if(!e)throw new Error('Navigation unavailable');e.click();})()`);
    await until(`location.pathname===${JSON.stringify(path)}`, `The ${label} route did not load.`);
  };
  const api = async (path: string, body?: unknown, method = body ? "POST" : "GET") => evaluate(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},${body ? `body:${JSON.stringify(JSON.stringify(body))},` : ""}credentials:'same-origin'}).then(async r=>({status:r.status,body:await r.json()}))`);
  const screenshot = async (name: string) => {
    const directory = process.env.ORCUS_BROWSER_SCREENSHOTS;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    await evaluate("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!await evaluate("document.body.innerText.includes('Loading venue snapshots...')||!!document.querySelector('.chart-loading')")) break;
      await delay(200);
    }
    await delay(450);
    assert.ok(!await evaluate("!!document.querySelector('nextjs-portal')"), "Use a production preview for screenshot evidence.");
    const result = await rpc("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(directory, `${name}.png`), Buffer.from(result.data, "base64"));
  };
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
  await navigate("Settings"); await clickText(".account-add-buttons button", "Hyperliquid");
  await until("!!document.querySelector('.account-card')", "The owned trading account did not load.");
  const account = (await api("/api/session")).body.data.accounts[0];
  assert.equal(account.address.toLowerCase(), owners[0].address.toLowerCase()); checks.push("actual signed HTTP login and owned Hyperliquid account registration");
  await navigate("Trade");
  await until("document.body.innerText.includes('Agent operating wallet')", "Distinct wallet roles were not rendered.");
  assert.ok(await evaluate("document.body.innerText.includes('Owner wallet')&&document.body.innerText.includes('Hyperliquid trading account')")); checks.push("owner, shared trading and operating wallet roles remain distinct");
  await evaluate("window.__orcusNavigationProof='preserved'");
  await evaluate("history.back()"); await until("location.pathname==='/settings'", "Browser back did not restore Settings.");
  await evaluate("history.forward()"); await until("location.pathname==='/trade'", "Browser forward did not restore Trade.");
  assert.equal(await evaluate("window.__orcusNavigationProof"), "preserved");
  await navigate("Overview"); await until("document.querySelector('h1')?.textContent==='Overview'", "Root is not the overview dashboard.");
  await navigate("Agent"); await until("!!document.querySelector('button[aria-label=\"Pause agent\"]')", "The dedicated agent workspace did not load.");
  checks.push("real route links, root overview and browser back/forward preserve the shared workspace document");
  const before = controlRequests;
  await evaluate("(()=>{const e=document.querySelector('button[aria-label=\"Pause agent\"]');e.click();e.click()})()");
  await until("!!document.querySelector('button[aria-label=\"Resume agent\"]')", "The paused agent state did not load.");
  assert.equal(controlRequests - before, 1); checks.push("rapid double pause sends one request; owner trading controls remain available");
  await click("button[aria-label=\"Resume agent\"]");
  await until("!!document.querySelector('button[aria-label=\"Pause agent\"]')", "Agent resume did not load.");
  const requestId = crypto.randomUUID(), beforePosts = agentPosts;
  const accepted = await api("/api/agent/requests", { requestId, message: "Review my account exposure", accountId: account.id, autonomous: false });
  assert.equal(accepted.status, 202); assert.equal(accepted.body.data.request.status, "queued");
  await navigate("Trade");
  await until("!document.querySelector('.workspace-notices .notice')", "A noncritical notice persisted across route navigation.");
  await navigate("Activity"); await click("button[aria-label=\"Refresh accounts\"]");
  await until("document.body.innerText.includes('Agent instruction')", "Saved queued instruction did not reach Activity.");
  await navigate("Agent");
  await until("document.body.innerText.includes('Review my account exposure')", "Accepted instruction was not restored in Agent.");
  assert.equal((await api(`/api/agent/requests/${requestId}`)).body.data.request.status, "queued");
  assert.equal(agentPosts - beforePosts, 1); checks.push("actual durable HTTP intake remains queued across route navigation with no automatic repost");
  for (const label of ["Overview", "Trade", "Agent", "Activity", "Automations", "Settings"]) {
    await navigate(label); await evaluate("scrollTo(0,0)"); await screenshot(`connected-desktop-${label.toLowerCase()}`);
  }
  await rpc("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const label of ["Overview", "Trade", "Agent", "Activity", "Automations", "Settings"]) {
    await navigate(label); await evaluate("scrollTo(0,0)");
    assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth"), `${label} overflows on mobile.`);
    await screenshot(`connected-mobile-${label.toLowerCase()}`);
    if (label === "Trade") {
      for (const tab of ["Depth", "Ticket", "Accounts"]) {
        await evaluate(`(()=>{const e=[...document.querySelectorAll('.trade-mobile-tabs button')].find(e=>e.textContent===${JSON.stringify(tab)});if(!e)throw new Error('Terminal view unavailable');e.click()})()`);
        await screenshot(`connected-mobile-trade-${tab.toLowerCase()}`);
        assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth"), `${tab} view overflows on mobile.`);
      }
    }
  }
  await click(".workspace-menu-toggle");
  await until("!document.querySelector('#mobile-workspace-navigation').hidden", "Mobile navigation did not open.");
  await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("document.querySelector('#mobile-workspace-navigation').hidden", "Escape did not dismiss mobile navigation.");
  checks.push("all six owner-scoped routes fit a390px viewport");
  await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const created = await api("/api/automations", { kind: "alert", name: "Browser expiry proof", accountId: account.id, intervalSeconds: 60, condition: { symbol: "ETH", operator: "above", price: "1" }, expiresAt: Date.now() + 1500 });
  assert.equal(created.status, 201);
  await delay(1800); await click("button[aria-label=\"Refresh accounts\"]"); await navigate("Automations");
  await until("!!document.querySelector('button[aria-label=\"Automation expired\"]:disabled')", "Expired automation incorrectly offers resume.");
  const automationId = created.body.data.id ?? created.body.data.automation?.id;
  const expiredResume = await api(`/api/automations/${automationId}`, { status: "active" }, "PATCH");
  assert.equal(expiredResume.status, 400); assert.equal(expiredResume.body.error.code, "INVALID_EXPIRY"); checks.push("expired automation is disabled in browser and rejected by actual HTTP API");
  await navigate("Agent");
  if (agentFixtures) {
    const agentData = (await api("/api/agent")).body.data;
    const proposal = { kind: "alert", name: "Fixture ETH crossing", accountId: account.id, intervalSeconds: 300, executionMode: "on-crossing", maxExecutions: 3, condition: { symbol: "ETH", operator: "above", price: "2400" }, expiresAt: Date.now() + 3_600_000 };
    const messages = [
      { id: "fixture-user", role: "user", content: "Research ETH and draft a bounded price alert.", createdAt: Date.now() },
      { id: "fixture-research", role: "assistant", content: "## Market brief\n\nFrontend fixture, not live market evidence.\n\n| Market | Observed price | Context |\n| --- | ---: | --- |\n| ETH | $2,350 | Example only |\n| BTC | $80,000 | Example only |\n\n- The price condition is not met.\n- No trade has been submitted.", createdAt: Date.now(), toolSteps: [{ name: "read_markets", ok: true, observedAt: Date.now(), sources: [{ id: "fixture-source", title: "Example research source (fixture)", url: "https://example.com/research", retrievedAt: Date.now(), network: "fixture" }] }, { name: "search_research", ok: false, observedAt: Date.now() }] },
      { id: "fixture-proposal", role: "assistant", content: "Review this price alert. It cannot activate without your approval.", createdAt: Date.now(), automationProposal: proposal },
    ];
    await evaluate(`(()=>{
      const original=window.fetch.bind(window); window.__orcusOriginalFetch=original;
      const state=window.__orcusAgentFixture={enabled:true,posts:0,releases:[],bodies:[],modelUpdates:0,selectedModel:'fixture-configured',messages:${JSON.stringify(messages)}};
      window.fetch=async(input,options={})=>{
        const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
        const method=options.method??'GET';
        if(state.enabled&&path==='/api/agent/models')return new Response(JSON.stringify({data:{defaultModelId:'fixture-configured',selectedModelId:state.selectedModel,catalogAvailable:true,models:[{id:'fixture-configured',name:'Configured model (fixture)',available:true,compatibility:'configured',privacy:'unverified'},{id:'fixture-catalog',name:'Catalog model (fixture)',available:true,compatibility:'catalog',privacy:'catalog-tee',pricing:{promptPerMillionUsd:'0.1',completionPerMillionUsd:'0.2'}},{id:'fixture-unavailable',name:'Unavailable model (fixture)',available:false,compatibility:'catalog',privacy:'unverified'}]}}),{headers:{'Content-Type':'application/json'}});
        if(state.enabled&&path==='/api/agent/control'&&method==='POST'&&JSON.parse(options.body).modelId){state.modelUpdates++;state.selectedModel=JSON.parse(options.body).modelId;return new Response(JSON.stringify({data:${JSON.stringify(agentData)}}),{headers:{'Content-Type':'application/json'}});}
        if(path==='/api/automations'&&method==='POST'){
          state.posts++;state.bodies.push(JSON.parse(options.body));
          return new Promise(resolve=>state.releases.push(ok=>resolve(new Response(JSON.stringify(ok?{data:{id:'fixture-automation'}}:{error:{code:'REVIEW_REQUIRED',message:'Fixture refusal. Review the rule before retrying.'}}),{status:ok?201:409,headers:{'Content-Type':'application/json'}}))));
        }
        if(state.enabled&&method==='GET'&&path==='/api/agent')return new Response(JSON.stringify({data:{...${JSON.stringify(agentData)},messages:state.messages}}),{headers:{'Content-Type':'application/json'}});
        const response=await original(input,options);
        if(state.enabled&&path==='/api/health'){const body=await response.json();body.data.cre.ready=true;return new Response(JSON.stringify(body),{status:response.status,headers:{'Content-Type':'application/json'}});}
        return response;
      };
    })()`);
    await navigate("Automations"); await navigate("Agent");
    await until("document.querySelector('select[aria-label=\"Inference model\"]')?.value==='fixture-configured'", "Model catalog fixture did not render.");
    assert.ok(await evaluate("document.querySelector('select[aria-label=\"Inference model\"] option[value=\"fixture-unavailable\"]').disabled"));
    await evaluate("(()=>{const select=document.querySelector('select[aria-label=\"Inference model\"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'fixture-catalog');select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await until("document.querySelector('select[aria-label=\"Inference model\"]').value==='fixture-catalog'", "Confirmed model preference did not update.");
    assert.equal(await evaluate("window.__orcusAgentFixture.modelUpdates"), 1);
    await until("!document.querySelector('button[aria-label=\"Refresh accounts\"]').disabled", "Refresh did not finish before fixture setup.");
    await click("button[aria-label=\"Refresh accounts\"]");
    await until("!!document.querySelector('.automation-approval-card')", "Structured fixture proposal did not render.");
    for (const viewport of [{ width: 1366, height: 768, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      await rpc("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
      await delay(200);
      const layout = await evaluate("(()=>{const c=document.querySelector('.chat-scroll').getBoundingClientRect(),f=document.querySelector('.chat-compose').getBoundingClientRect();return {page:document.documentElement.scrollHeight,height:innerHeight,thread:c.height,composerBottom:f.bottom,composerTop:f.top}})()");
      assert.ok(layout.page <= layout.height + 1, `Agent route must not have page scrolling: ${JSON.stringify(layout)}`);
      assert.ok(layout.thread >= 440, `Conversation must have useful height: ${JSON.stringify(layout)}`);
      assert.ok(layout.composerBottom <= layout.height && layout.composerTop > 0, "Composer stays visible.");
      await click(".model-details summary");
      assert.equal(await evaluate("document.querySelector('.chat-scroll').getBoundingClientRect().height"), layout.thread, "Model details must not shrink the thread.");
      await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await evaluate("document.querySelector('.model-details').open=false");
      await click("button[aria-controls=\"agent-context\"]");
      await until("document.querySelector('button[aria-controls=\"agent-context\"]').getAttribute('aria-expanded')==='true'", "Context did not open.");
      if (viewport.mobile) {
        await until("!!document.querySelector('dialog[open]')", "Mobile context drawer did not open.");
        assert.ok(await evaluate("document.querySelector('dialog').contains(document.activeElement)"), "Mobile drawer must receive focus.");
      }
      await screenshot(viewport.mobile ? "fixture-mobile-context" : "fixture-laptop-context");
      await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await until("document.querySelector('button[aria-controls=\"agent-context\"]').getAttribute('aria-expanded')==='false'", "Escape must close context.");
      assert.ok(await evaluate("document.activeElement===document.querySelector('button[aria-controls=\"agent-context\"]')"), "Context dismissal must restore focus.");
    }
    await rpc("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('.chat-scroll').scrollTop=0"); await delay(150);
    const historyTop = await evaluate("document.querySelector('.chat-scroll').scrollTop");
    await evaluate("window.__orcusAgentFixture.messages.push({id:'fixture-appended-answer',role:'assistant',content:'Fixture answer arriving while reading history.',createdAt:Date.now()})");
    await until("!document.querySelector('button[aria-label=\"Refresh accounts\"]').disabled", "Refresh is unavailable.");
    await click("button[aria-label=\"Refresh accounts\"]");
    await until("document.body.innerText.includes('Fixture answer arriving while reading history.')", "Fixture answer was not appended.");
    assert.equal(await evaluate("document.querySelector('.chat-scroll').scrollTop"), historyTop, "Incoming content must not move a reader away from history.");
    await click(".jump-to-latest");
    assert.ok(await evaluate("(()=>{const e=document.querySelector('.chat-scroll');return e.scrollHeight-e.scrollTop-e.clientHeight<2})()"), "Jump to latest must reach the bottom.");
    fixtureChecks.push("frontend fixture: single-scroll full-height chat at1366x768 and390x844, overlay model details, keyboard context dismissal and stable history on incoming answers");
    assert.ok(await evaluate("document.querySelector('.automation-approval-card > button.button.primary').disabled"), "Approval must require explicit review.");
    await evaluate("document.querySelector('.chat-scroll').scrollTop=0;scrollTo(0,0)");
    await screenshot("fixture-desktop-research");
    await evaluate("document.querySelector('.automation-approval-card').scrollIntoView({block:'nearest'});scrollTo(0,0)");
    await screenshot("fixture-desktop-approval");
    assert.ok(await evaluate("document.querySelector('.chat-compose').getBoundingClientRect().bottom<=innerHeight"), "Desktop composer should stay visible.");
    await rpc("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.querySelector('.agent-table-scroll').scrollIntoView({block:'center',behavior:'instant'})");
    assert.ok(await visibleInChat(".agent-table-scroll"), "Research table must be fully visible on mobile.");
    await screenshot("fixture-mobile-research");
    assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth"), "Populated research must not overflow mobile.");
    await evaluate("document.querySelector('.automation-approval-card > button.button.primary').scrollIntoView({block:'end',behavior:'instant'})");
    assert.ok(await visibleInChat(".approval-acknowledgement"), "Approval acknowledgement must be visible on mobile.");
    assert.ok(await visibleInChat(".automation-approval-card > button.button.primary"), "Activation button must be visible on mobile.");
    await screenshot("fixture-mobile-approval");
    await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('.automation-approval-card > button.button.primary').scrollIntoView({block:'end',behavior:'instant'})");
    assert.ok(await visibleInChat(".approval-acknowledgement"), "Acknowledgement must be visible before user approval.");
    await click(".approval-acknowledgement input");
    await until("!document.querySelector('.automation-approval-card > button.button.primary').disabled", "Reviewed fixture proposal remained unavailable.");
    assert.ok(await visibleInChat(".automation-approval-card > button.button.primary"), "Activation must be visible before clicking.");
    await evaluate("(()=>{const button=document.querySelector('.automation-approval-card > button.button.primary');button.click();button.click()})()");
    assert.equal(await evaluate("window.__orcusAgentFixture.posts"), 1);
    assert.deepEqual(await evaluate("window.__orcusAgentFixture.bodies[0]"), proposal);
    await evaluate("window.__orcusAgentFixture.releases.shift()(false)");
    await until("document.querySelector('.automation-approval-card [role=alert]')?.innerText==='The action could not be completed. Refresh and try again.'", "Sanitized activation refusal was not visible.");
    assert.ok(await evaluate("!document.querySelector('.automation-approval-card').innerText.includes('Automation activated')"));
    await evaluate("document.querySelector('.automation-approval-card > button.button.primary').scrollIntoView({block:'end',behavior:'instant'})");
    assert.ok(await visibleInChat(".automation-approval-card > button.button.primary"), "Retry must be visible after refusal.");
    await click(".automation-approval-card > button.button.primary");
    assert.equal(await evaluate("window.__orcusAgentFixture.posts"), 2);
    fixtureChecks.push("frontend fixture: research table and successful-source references render on desktop/mobile without overflow");
    fixtureChecks.push("frontend fixture: explicit approval sends unchanged proposal once under rapid clicks and displays refusal without claiming activation");
    fixtureChecks.push("frontend fixture: catalog model choice saves once and unavailable models cannot be selected");
  }
  await evaluate("(()=>{const e=document.querySelector('textarea[aria-label=\"Message your agent\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'private-owner-one-draft');e.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await until("!document.querySelector('button[aria-label=\"Refresh accounts\"]').disabled", "An earlier refresh did not finish.");
  holdNextOwnerRead = true; await click("button[aria-label=\"Refresh accounts\"]");
  for (let attempt = 0; !releaseOwnerRead && attempt < 50; attempt++) await delay(100);
  assert.ok(releaseOwnerRead, "The old owner refresh was not held for the race test.");
  ownerIndex = 1; await evaluate("if(window.__orcusAgentFixture)window.__orcusAgentFixture.enabled=false;window.__orcusWalletChanged()");
  await until("!!document.querySelector('.connect-button')", "Wallet change did not clear the authenticated workspace.");
  assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"Message your agent\"]').value"), "");
  await until("fetch('/api/session').then(r=>r.json()).then(r=>r.data.user===null)", "The old HTTP session was not cleared.");
  await click(".connect-button"); await until("!!document.querySelector('.wallet-button')", "The second owner could not sign in.");
  releaseOwnerRead(); await delay(1000);
  if (agentFixtures) {
    await evaluate("window.__orcusAgentFixture.releases.shift()(true)");
    await delay(300);
    assert.ok(await evaluate("!document.querySelector('.automation-approval-card')&&!document.body.innerText.includes('Fixture ETH crossing')"), "Old-owner approval leaked into the new session.");
    await evaluate("window.fetch=window.__orcusOriginalFetch");
    fixtureChecks.push("frontend fixture: delayed activation response cannot restore an old owner proposal after wallet switch");
  }
  const second = (await api("/api/session")).body.data;
  assert.equal(second.user.address.toLowerCase(), owners[1].address.toLowerCase()); assert.equal(second.accounts.length, 0);
  checks.push("wallet switch clears private drafts, old session and cross-owner trading accounts");
  checks.push("a delayed old-owner refresh cannot clear or log out the newly signed-in owner");
  assert.equal(exchangeRequests, 0); assert.equal(tradeSignatureAttempts, 0);
  console.log(JSON.stringify({ scope: "local Chromium with injected disposable wallet and real HTTP/SQLite", checks, fixtureChecks, publicTradingWrites: 0, paidInferenceCalls: 0, notProven: ["real browser-extension behavior", "funded or public venue execution", "sponsor deployment", "worker processing or paid0G inference", ...(agentFixtures ? ["fixture activation is frontend-only proof, not backend execution"] : [])] }, null, 2));
} finally {
  await closeBrowser?.().catch(() => undefined);
  socket?.close(); browser.kill("SIGTERM");
  await new Promise(resolve => { if (browser.exitCode !== null) resolve(undefined); else { browser.once("exit", resolve); setTimeout(resolve, 3000); } });
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
