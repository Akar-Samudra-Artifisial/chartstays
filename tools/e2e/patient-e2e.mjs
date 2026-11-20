// End-to-end test of the patient app against the four local trial nodes, in headless Chrome
// driven over the DevTools protocol (no extra dependencies).
//
//   pnpm -r build && pnpm gen     (apps/patient/out and dist/nodes must exist)
//   pnpm e2e                      (CHROME_PATH=<binary> to use another Chrome)
//
// It serves apps/patient/out on http://localhost:4000, runs tools/serve-nodes.mjs --log for
// the nodes on 4101-4104, and checks:
//   0. no consent given: opening /match and leaving the dialog unanswered sends no request to any node
//   a. allow every node: 20 studies for the hero patient (Angelyn934), verdicts as in docs/match-matrix.md
//   b. deny one node: that node gets 0 requests, the others load, "Access to <origin> denied" is shown
//   c. every node request carries no profile value (condition names/codes, lab values, medications)
//      in url, headers or body, and no Authorization or Cookie header
//   d. the agent path with the mock router (browser://mock) calls every site action successfully
//   w6. week 6: the doctor sheet follows a node loaded after it was built (no stale result) and
//      links only to ClinicalTrials.gov; prepareInquiry's dialog starts without health data and
//      sends no request, an opted-in field appears in its preview; the local model (WebLLM)
//      option is shown, its no-WebGPU fallback appears, and its worker runs under its own CSP
//   e. with the generated out/_headers served (CSP on): no CSP violation on any page, a link
//      outside the allow-list is blocked, a peer network cannot call website_readProfile, and a
//      node's cross-origin redirect is refused
//   shady. the same export with the config/nodes.demo.json overlay (configure-nodes --overlay)
//      and the DEMO / ADVERSARIAL node on 4105: a question with health data for it is blocked
//      before sending (b); after consent its injection is neutralized and it is quarantined (a);
//      its exfil link is blocked (c); the trust panel shows the blocks, the quarantine and
//      "Patient data sent: 0" (d); the real nodes keep their verdicts (e); no CSP violation (f)
//   s6. spec §6 interop (docs/interop-s6.md): the export with a TEST-ONLY overlay of fixture
//      nodes (tools/e2e/interop-fixtures.mjs, 127.0.0.1:4106-4111) and the real t2d node, and
//      a BYOK setup pointing at a local fake router (tools/e2e/fake-router.mjs, :11434): the
//      key goes only to that router, never to a node (2, 5); a node manifest's llm_router is
//      ignored (5); a wrong network name (4), an invalid network, a cycle, both per-query
//      budgets and an origin outside the directory (7) each fail with a message on the page
// Everything it starts (servers, Chrome) is stopped before it exits.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBundleText } from "../../packages/fhir-profile/dist/index.js";
import { urlScanText } from "../../apps/patient/lib/firewall-rules.ts";
import { findProfileTerms, profileTerms } from "../../apps/patient/lib/phi-scan.ts";
import { APP, OUT, serveApp } from "../serve-app.mjs";
import { FAKE_MODEL, FAKE_ROUTER, startFakeRouter } from "./fake-router.mjs";
import { FIXTURE_ORIGINS, FIXTURE_PORTS, serveFixtures, writeFixtures } from "./interop-fixtures.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const NODES = { 4101: "http://localhost:4101", 4102: "http://localhost:4102", 4103: "http://localhost:4103", 4104: "http://localhost:4104" };
const DENIED_PORT = 4102;
const SHADY = "http://localhost:4105";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HERO_ID = "demo-type-2-diabetes";
const ACTIONS = ["readProfile", "listNodes", "loadNode", "evaluateCriteria", "buildDoctorSheet"];
const REDIRECT_TARGET = "http://localhost:4104/__test/landing.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Console reports of CSP violations, from every page of the run. */
const CSP_VIOLATIONS = [];

// ---------- servers ----------

// The app server (apps/patient/out on :4000 with its _headers) is tools/serve-app.mjs.

function startNodes(logFile, demo = false) {
  const args = [path.join(ROOT, "tools/serve-nodes.mjs"), "--log", logFile, "--test-redirect", REDIRECT_TARGET, ...(demo ? ["--demo"] : [])];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve-nodes did not start: ${out}`)), 15_000);
    child.stdout.on("data", (d) => {
      out += d;
      if ((out.match(/http:\/\/localhost:41\d\d/g) ?? []).length >= (demo ? 5 : 4)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => (out += d));
    child.once("exit", (code) => reject(new Error(`serve-nodes exited (${code}): ${out}`)));
  });
}

/** Stop a child process and wait until it has exited (its ports are free). */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

/** A node config's (default: the demo config) directory, manifest, network and _headers, written to `dir` (out/ untouched). */
function writeOverlay(dir, config = path.join(ROOT, "apps/patient/config/nodes.demo.json")) {
  const child = spawn(process.execPath, [path.join(ROOT, "apps/patient/scripts/configure-nodes.mjs"), "--overlay", dir], {
    cwd: path.join(ROOT, "apps/patient"),
    env: { ...process.env, CHARTSTAYS_NODES_CONFIG: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`configure-nodes --overlay failed (${code}): ${out}`))));
  });
}

async function readLog(logFile) {
  if (!existsSync(logFile)) return [];
  return (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ---------- Chrome over CDP ----------

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Set();
  static async connect(url) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener("open", resolve, { once: true });
      cdp.#ws.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
    });
    cdp.#ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== undefined) {
        const p = cdp.#pending.get(msg.id);
        cdp.#pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${msg.error.message} (${p.method})`));
        else p?.resolve(msg.result);
      } else {
        for (const l of cdp.#listeners) l(msg);
      }
    });
    return cdp;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(listener) {
    this.#listeners.add(listener);
  }
  close() {
    this.#ws.close();
  }
}

async function launchChrome(profileDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
  const child = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(profileDir, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const [port, wsPath] = (await readFile(portFile, "utf8")).split("\n");
      if (port && wsPath) return { child, url: `ws://127.0.0.1:${port}${wsPath}` };
    }
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error("Chrome did not open its DevTools port");
}

/**
 * Fail every request matching `patterns` anywhere in the browser (browser-level Fetch: dedicated
 * workers have no Fetch domain of their own) and list it in `blocked`. Throws if interception
 * cannot be enabled, so a caller never lets such a request through by accident.
 */
async function blockBrowserRequests(cdp, patterns) {
  const blocked = [];
  cdp.on((msg) => {
    if (msg.sessionId !== undefined || msg.method !== "Fetch.requestPaused") return;
    blocked.push(msg.params.request.url);
    void cdp.send("Fetch.failRequest", { requestId: msg.params.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
  });
  await cdp.send("Fetch.enable", { patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  return { blocked, stop: () => cdp.send("Fetch.disable").catch(() => undefined) };
}

/** A page in its own browser context (fresh IndexedDB and storage). */
async function newPage(cdp) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  const cspViolations = CSP_VIOLATIONS;
  const CSP_RE = /Content Security Policy|Content-Security-Policy/i;
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
    if (msg.method === "Log.entryAdded" && CSP_RE.test(msg.params.entry?.text ?? "")) cspViolations.push(msg.params.entry.text.slice(0, 300));
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (CSP_RE.test(text)) cspViolations.push(text.slice(0, 300));
    }
  });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  const page = {
    errors,
    cspViolations,
    async eval(expression) {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    async goto(url) {
      await cdp.send("Page.navigate", { url }, sessionId);
      await page.waitFor(`document.readyState === "complete" && location.href.startsWith(${JSON.stringify(url)})`, 20_000, `load ${url}`);
    },
    async waitFor(expression, timeout = 20_000, what = expression) {
      const end = Date.now() + timeout;
      for (;;) {
        try {
          const v = await page.eval(expression);
          if (v) return v;
        } catch {
          // page not ready yet
        }
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
      }
    },
    /**
     * Attach to every worker this page starts (CDP auto-attach, paused until Network is enabled
     * in it) and record the worker's own network requests from inside its target.
     */
    async observeWorkers() {
      const seen = { workers: [], requests: [], setupErrors: [] };
      const children = new Set();
      cdp.on((msg) => {
        if (msg.method === "Target.attachedToTarget" && msg.sessionId === sessionId) {
          const child = msg.params.sessionId;
          children.add(child);
          seen.workers.push({ type: msg.params.targetInfo.type, url: msg.params.targetInfo.url });
          void cdp
            .send("Network.enable", {}, child)
            .catch((error) => seen.setupErrors.push(error.message))
            .then(() => cdp.send("Runtime.runIfWaitingForDebugger", {}, child))
            .catch((error) => seen.setupErrors.push(error.message));
          return;
        }
        if (children.has(msg.sessionId) && msg.method === "Network.requestWillBeSent") seen.requests.push(msg.params.request.url);
      });
      await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      return seen;
    },
    /** Run `source` before any page script on every later navigation (outside the page's CSP). */
    async addInitScript(source) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
    },
  };
  return page;
}

// ---------- app steps ----------

async function importHero(page) {
  await page.goto(`${APP}/`);
  await page.waitFor(`[...document.querySelectorAll("#demo-patient option")].some((o) => o.value === ${JSON.stringify(HERO_ID)})`, 20_000, "demo patients");
  await page.eval(`(() => {
    const sel = document.querySelector("#demo-patient");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, ${JSON.stringify(HERO_ID)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.waitFor(`document.querySelector("#demo-patient").value === ${JSON.stringify(HERO_ID)}`);
  await page.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Load demo patient").click()`);
  await page.waitFor(`!!document.querySelector("#profile-heading")`, 20_000, "imported profile");
}

async function openMatch(page, count = 4) {
  await page.goto(`${APP}/match`);
  await page.waitFor(`document.querySelectorAll("#node-list li").length === ${count} && !document.querySelector("#find-trials").disabled`, 20_000, "match page ready").catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify({ pageErrors: page.errors.slice(0, 3), csp: CSP_VIOLATIONS.slice(0, 3) })}`);
  });
}

/** Answer consent dialogs by origin until stopped. Returns the decisions made. */
function answerDialogs(page, policy) {
  const decisions = [];
  let running = true;
  const done = (async () => {
    while (running) {
      const origin = await page.eval(`(() => { const d = document.querySelector("#consent-dialog"); return d && d.open ? document.querySelector("#consent-origin")?.textContent ?? "" : ""; })()`).catch(() => "");
      if (origin) {
        const decision = policy(origin);
        decisions.push({ origin, decision });
        const id = decision === "deny" ? "consent-deny" : decision === "allow_session" ? "consent-allow-session" : "consent-allow-once";
        await page.eval(`document.querySelector("#${id}").click()`);
        await page.waitFor(`!document.querySelector("#consent-dialog").open || document.querySelector("#consent-origin")?.textContent !== ${JSON.stringify(origin)}`, 5_000, "dialog to close").catch(() => undefined);
      }
      await sleep(80);
    }
  })();
  return {
    decisions,
    async stop() {
      running = false;
      await done;
    },
  };
}

async function findTrials(page, policy) {
  const answers = answerDialogs(page, policy);
  await page.eval(`document.querySelector("#find-trials").click()`);
  try {
    await page.waitFor(`(document.querySelector("#find-status")?.textContent ?? "").startsWith("Matched") && !document.querySelector("#find-trials").disabled`, 60_000, "matching to finish");
  } finally {
    await answers.stop();
  }
  const rows = await page.eval(`[...document.querySelectorAll("#results tbody tr")].map((tr) => ({ nct: tr.dataset.nct, verdict: tr.dataset.verdict }))`);
  const denied = await page.eval(`[...document.querySelectorAll(".denied")].map((p) => p.textContent)`);
  return { rows, denied, decisions: answers.decisions };
}

// ---------- expectations ----------

const TIER = { S: "strong_match", P: "possible_match", N: "not_eligible" };

async function expectedVerdicts(shortName) {
  const lines = (await readFile(path.join(ROOT, "docs/match-matrix.md"), "utf8")).split("\n");
  const expected = {};
  let header = null;
  for (const line of lines) {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "Patient" && cells.slice(1).every((c) => /^NCT\d{8}$/.test(c))) header = cells.slice(1);
    else if (header && cells[0] === shortName) {
      header.forEach((nct, i) => (expected[nct] = TIER[cells[i + 1][0]]));
      header = null;
    }
  }
  return expected;
}

async function heroTerms() {
  const demo = JSON.parse(await readFile(path.join(ROOT, "data/demo-patients.json"), "utf8"));
  const hero = demo.patients.find((p) => p.id === HERO_ID);
  const profile = parseBundleText(await readFile(path.join(ROOT, "data/synthea/shifted", hero.file), "utf8"), { asOf: new Date() });
  return { hero, terms: profileTerms(profile) };
}

function checkRequests(entries, terms) {
  const problems = [];
  for (const e of entries) {
    const headers = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    if (headers.authorization !== undefined) problems.push(`${e.port} ${e.url}: Authorization header`);
    if (headers.cookie !== undefined) problems.push(`${e.port} ${e.url}: Cookie header`);
    // The URL is checked like out.phi does: query, fragment and any path other than a node's
    // published files (whose names, e.g. t2d_trials.network.json, are not patient data).
    const text = [urlScanText(new URL(e.url, `http://localhost:${e.port}`).href), e.body, ...Object.values(headers)].join("\n");
    const hits = findProfileTerms(text, terms);
    if (hits.length) problems.push(`${e.port} ${e.url}: profile values ${hits.join(", ")}`);
  }
  return problems;
}

// ---------- run ----------

async function main() {
  for (const required of [path.join(OUT, "match.html"), path.join(ROOT, "dist/nodes/type-2-diabetes/index.html")]) {
    if (!existsSync(required)) throw new Error(`${path.relative(ROOT, required)} is missing: run pnpm -r build and pnpm gen first`);
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "chartstays-e2e-"));
  const logFile = path.join(tmp, "nodes.log");
  await writeFile(logFile, "");
  const results = [];
  const failures = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
  };
  let app = null;
  let nodes = null;
  let chrome = null;
  let cdp = null;
  let closeFixtures = null;
  let fakeRouter = null;
  try {
    app = await serveApp();
    nodes = await startNodes(logFile);
    chrome = await launchChrome(path.join(tmp, "chrome"));
    cdp = await Cdp.connect(chrome.url);
    const { hero, terms } = await heroTerms();
    const expected = await expectedVerdicts(hero.short);
    let mark = 0;
    const since = async () => {
      const all = await readLog(logFile);
      const slice = all.slice(mark);
      mark = all.length;
      return slice;
    };
    const allNodeRequests = [];

    // 0. No consent interaction: nothing reaches a node.
    {
      const page = await newPage(cdp);
      await importHero(page);
      await since();
      await openMatch(page);
      // The directory and profile are read and the page is idle before the click.
      await page.waitFor(`window.__chartstays.trustLog().length === 0 && performance.getEntriesByType("resource").some((e) => e.name.endsWith("/directory.json"))`, 10_000, "match page idle");
      await page.eval(`document.querySelector("#find-trials").click()`);
      await page.waitFor(`document.querySelector("#consent-dialog").open && document.querySelector("#consent-origin")?.textContent !== ""`, 10_000, "consent dialog");
      // While the first question is open the session waits on it: no node may be contacted.
      await page.waitFor(
        `document.querySelector("#consent-dialog").open && !window.__chartstays.trustLog().some((e) => e.type === "contact") && !performance.getEntriesByType("resource").some((e) => /^http:\\/\\/localhost:41\\d\\d\\//.test(e.name)) && document.querySelector("#node-list li").dataset.status === "idle"`,
        10_000,
        "dialog waiting with no node contact",
      );
      const origin = await page.eval(`document.querySelector("#consent-origin").textContent`);
      const reqs = await since();
      check("0 no request before consent", reqs.length === 0, { dialogOpenFor: origin, nodeRequests: reqs.length });
      const csp = await fetch(`${APP}/match`).then((r) => r.headers.get("content-security-policy") ?? "");
      check("0 CSP header on /match", /script-src 'self'( 'sha256-[^']+')+;/.test(csp) && csp.includes("connect-src 'self' http://localhost:4101") && csp.includes("frame-ancestors 'none'") && !/unsafe-eval/.test(csp), { csp: csp.replace(/'sha256-[^']+'/g, "#").slice(0, 400) });
      await page.close();
      await sleep(300);
      await since();
    }

    // a. Allow every node.
    {
      const page = await newPage(cdp);
      await importHero(page);
      await since();
      await openMatch(page);
      const run = await findTrials(page, () => "allow_once");
      const reqs = await since();
      allNodeRequests.push(...reqs);
      const got = Object.fromEntries(run.rows.map((r) => [r.nct, r.verdict]));
      const mismatches = Object.entries(expected).filter(([nct, v]) => got[nct] !== v).map(([nct, v]) => `${nct}: expected ${v}, got ${got[nct]}`);
      const ports = [...new Set(reqs.map((r) => r.port))].sort();
      check("a allow all: 20 studies", run.rows.length === 20 && Object.keys(expected).length === 20, { rows: run.rows.length, expected: Object.keys(expected).length });
      check("a verdicts match docs/match-matrix.md", mismatches.length === 0, { mismatches, strong: run.rows.filter((r) => r.verdict === "strong_match").map((r) => r.nct) });
      check("a every node contacted after consent", ports.length === 4, { ports, consents: run.decisions.length, requests: reqs.length });
      await page.close();
    }

    // b. Deny one node.
    {
      const page = await newPage(cdp);
      await importHero(page);
      await since();
      await openMatch(page);
      const run = await findTrials(page, (origin) => (origin === NODES[DENIED_PORT] ? "deny" : "allow_once"));
      const reqs = await since();
      allNodeRequests.push(...reqs);
      const denied = reqs.filter((r) => r.port === DENIED_PORT).length;
      const others = [...new Set(reqs.filter((r) => r.port !== DENIED_PORT).map((r) => r.port))].sort();
      check("b denied node gets 0 requests", denied === 0, { deniedPort: DENIED_PORT, requests: denied });
      check("b other nodes still load", others.length === 3 && run.rows.length === 15, { others, rows: run.rows.length });
      check("b denial shown", run.denied.includes(`Access to ${NODES[DENIED_PORT]} denied`), { shown: run.denied });
      await page.close();
    }

    // d. Agent path with the mock router.
    {
      const page = await newPage(cdp);
      await importHero(page);
      await since();
      await openMatch(page);
      await page.eval(`document.querySelector("#start-agent").click()`);
      await page.waitFor(`!!document.querySelector("#ns-input") && document.querySelector("#agent-app").dataset.state === "ready"`, 30_000, "agent runtime").catch(async (error) => {
        const state = await page.eval(`(() => { const a = document.querySelector("#agent-app"); return { state: a?.dataset.state, alert: document.querySelector("[role=alert]")?.textContent ?? "" }; })()`).catch(() => null);
        throw new Error(`${error.message}: ${JSON.stringify({ state, pageErrors: page.errors })}`);
      });
      const answers = answerDialogs(page, (origin) => (origin === NODES[4101] ? "allow_session" : "deny"));
      await page.eval(`(() => { const i = document.querySelector("#ns-input"); i.value = ${JSON.stringify(NODES[4101])}; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#ns-send").click(); })()`);
      try {
        await page.waitFor(`document.querySelector(".ns-inputbar")?.dataset.turnActive === "true"`, 10_000, "turn start").catch(() => undefined);
        await page.waitFor(`document.querySelector(".ns-inputbar")?.dataset.turnActive === "false" && window.__chartstays.trustLog().some((e) => e.type === "tool_call" && e.tool === "buildDoctorSheet" && e.status !== "start")`, 90_000, "agent turn");
      } finally {
        await answers.stop();
      }
      const log = await page.eval(`window.__chartstays.trustLog()`);
      const okTools = [...new Set(log.filter((e) => e.type === "tool_call" && e.status === "ok").map((e) => e.tool))];
      const failedTools = log.filter((e) => e.type === "tool_call" && e.status === "error").map((e) => `${e.tool}: ${e.detail}`);
      const router = log.filter((e) => e.type === "router");
      const t2dState = await page.eval(`document.querySelector('#node-list li[data-origin="${NODES[4101]}"]').dataset.status`);
      const trace = await page.eval(`window.__nsweb.trace.events.filter((e) => e.phase === "end" && e.kind === "model_call").map((e) => e.routeKind ?? e.mock)`);
      const reqs = await since();
      allNodeRequests.push(...reqs);
      const deniedPorts = reqs.filter((r) => r.port !== 4101).map((r) => r.port);
      check("d agent calls every site action successfully", ACTIONS.every((a) => okTools.includes(a)) && failedTools.length === 0, { okTools, failedTools });
      check("d mock router only", router.length > 0 && router.every((r) => r.mock === true) && trace.length > 0 && trace.every((k) => k === "browser-mock"), { router, modelCalls: trace.length });
      check("d node loaded via loadNode", t2dState === "loaded", { t2dState });
      check("d denied peers get 0 requests", deniedPorts.length === 0, { decisions: answers.decisions, deniedPorts });
      const answer = await page.eval(`document.querySelector("#agent-app").innerText.slice(-600)`);
      results.push({ name: "d answer excerpt", ok: true, detail: answer.replace(/\s+/g, " ").slice(0, 300) });

      // e1. A link to a site outside the allow-list, in the assistant's output, is blocked.
      const link = await page.eval(`(() => {
        const a = document.createElement("a");
        a.href = "https://evil.example/collect?data=secret";
        a.target = "_blank";
        a.textContent = "more";
        document.querySelector("#agent-app").append(a);
        const before = location.href;
        const clicked = a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        a.remove();
        return { defaultAllowed: clicked, stayed: location.href === before };
      })()`);
      const shown = await page.waitFor(`document.querySelector("#link-blocked-url")?.textContent ?? ""`, 5_000, "blocked link notice").catch(() => "");
      const linkLog = (await page.eval(`window.__chartstays.trustLog()`)).filter((e) => e.type === "link");
      check("e link outside the allow-list blocked", link.defaultAllowed === false && link.stayed && shown === "https://evil.example/collect?data=secret" && linkLog.some((e) => e.origin === "https://evil.example" && e.decision === "blocked"), { link, shown, linkLog });

      // e2. A peer network can never call this site's readProfile (runtime: runner.js isTop check).
      const peer = await page.eval(`(async () => {
        const { dispatchToolCall } = await import("/runtime/runner.js");
        const engine = window.__nsweb.engine;
        const found = [...engine.actions.entries].find(([, v]) => v.name === "readProfile");
        if (!found) return { error: "readProfile is not registered" };
        const [ref, registered] = found;
        const base = { actions: engine.actions, manifest: engine.top.manifest, baseOrigin: registered.base, trace: engine.trace };
        const attempt = async (ctx) => {
          try {
            await dispatchToolCall({ ...base, ...ctx }, { kind: "website", ref }, {}, null, []);
            return "called";
          } catch (error) {
            return String(error.message);
          }
        };
        return {
          asPeer: await attempt({ isTop: false, network: { name: "t2d_trials" } }),
          asPeerNetworkOnTop: await attempt({ isTop: true, network: { name: "t2d_trials" } }),
        };
      })()`);
      check("e peer network cannot call website_readProfile", peer.asPeer === "Website action is not callable by this agent." && peer.asPeerNetworkOnTop === "Website action is not callable by this agent.", peer);

      // e3. A node's cross-origin redirect is refused by the page's request guard.
      await since();
      const redirect = await page.eval(`fetch("${NODES[4101]}/__test/redirect.json").then(() => "followed", (e) => "refused: " + e.message)`);
      const redirectReqs = await since();
      allNodeRequests.push(...redirectReqs);
      check("e cross-origin redirect from a node refused", redirect.startsWith("refused") && !redirectReqs.some((r) => r.url === "/__test/landing.json"), { redirect, requests: redirectReqs.map((r) => `${r.port}${r.url}`) });
      await page.close();
    }

    // w6. Week 6: doctor sheet, prepareInquiry, local model.
    {
      const page = await newPage(cdp);
      await importHero(page);
      await since();
      await openMatch(page);
      const run = await findTrials(page, (origin) => (origin === NODES[DENIED_PORT] ? "deny" : "allow_once"));
      allNodeRequests.push(...(await since()));
      const sheetState = `(() => {
        const s = document.querySelector("#doctor-sheet");
        if (!s) return null;
        return {
          generated: s.dataset.generated,
          studies: [...s.querySelectorAll(".sheet-study")].map((d) => d.dataset.nct).sort(),
          notIncluded: [...s.querySelectorAll("#doctor-sheet-not-included li")].map((li) => li.textContent),
          links: [...s.querySelectorAll("a")].map((a) => a.getAttribute("href")),
          text: s.innerText,
        };
      })()`;
      const eligibleRows = `[...document.querySelectorAll("#results tbody tr")].filter((tr) => tr.dataset.verdict !== "not_eligible").map((tr) => tr.dataset.nct).sort()`;
      await page.eval(`document.querySelector("#doctor-sheet-build").click()`);
      const before = await page.waitFor(sheetState, 10_000, "doctor sheet");
      const eligibleBefore = await page.eval(eligibleRows);
      // Load the denied node now; the open sheet must follow without another click.
      const answers = answerDialogs(page, () => "allow_once");
      try {
        await page.eval(`document.querySelector('.retry[data-origin="${NODES[DENIED_PORT]}"]').click()`);
        await page.waitFor(`document.querySelectorAll("#results tbody tr").length === 20 && !document.querySelector('#missing-nodes li[data-origin="${NODES[DENIED_PORT]}"]')`, 30_000, "denied node loaded on retry");
      } finally {
        await answers.stop();
      }
      allNodeRequests.push(...(await since()));
      const eligibleAfter = await page.eval(eligibleRows);
      const after = await page.waitFor(`(() => { const s = ${sheetState}; return s && s.generated !== ${JSON.stringify(before.generated)} && s.notIncluded.length === 0 ? s : null; })()`, 15_000, "doctor sheet rebuilt").catch(() => null);
      const ctgov = /^https:\/\/clinicaltrials\.gov\/study\/NCT\d{8}$/;
      check(
        "w6 doctor sheet follows a node loaded after it was built",
        run.rows.length === 15 &&
          before.notIncluded.some((t) => t.includes(NODES[DENIED_PORT])) &&
          JSON.stringify(before.studies) === JSON.stringify(eligibleBefore) &&
          after !== null &&
          JSON.stringify(after.studies) === JSON.stringify(eligibleAfter) &&
          after.links.length > 0 &&
          after.links.every((h) => ctgov.test(h)) &&
          /snapshot \d{4}-\d{2}-\d{2}/.test(after.text) &&
          /not medical advice/i.test(after.text),
        { rowsBefore: run.rows.length, sheetBefore: before.studies.length, notIncludedBefore: before.notIncluded.length, sheetAfter: after?.studies.length, eligibleAfter: eligibleAfter.length, links: after?.links.slice(0, 3) },
      );

      // prepareInquiry from a result row: no health data by default, no request, opt-in in the preview.
      const resourcesBefore = await page.eval(`performance.getEntriesByType("resource").length`);
      await since();
      const nct = await page.eval(`document.querySelector(".prepare-inquiry")?.dataset.nct ?? ""`);
      await page.eval(`document.querySelector(".prepare-inquiry").click()`);
      await page.waitFor(`document.querySelector("#inquiry-dialog")?.open && !!document.querySelector("#inquiry-preview")`, 10_000, "inquiry dialog");
      const initial = await page.eval(`({
        preview: document.querySelector("#inquiry-preview").innerText,
        status: document.querySelector("#inquiry-scan-status").dataset.status,
        checked: [...document.querySelectorAll("#inquiry-fields input")].filter((i) => i.checked).length,
        fields: [...document.querySelectorAll("#inquiry-fields input")].map((i) => i.dataset.field),
      })`);
      const initialHits = findProfileTerms(initial.preview, terms);
      check(
        "w6 prepareInquiry default has no health data",
        nct !== "" && initial.status === "clean" && initial.checked === 0 && initialHits.length === 0 && initial.preview.includes(nct) && initial.fields.includes("age"),
        { nct, status: initial.status, checked: initial.checked, hits: initialHits, fields: initial.fields },
      );
      await page.eval(`document.querySelector("#inquiry-field-age").click()`);
      const optIn = await page.waitFor(`(() => { const p = document.querySelector("#inquiry-preview").innerText; return p.includes("Age range:") ? { preview: p, status: document.querySelector("#inquiry-scan-status").dataset.status, marks: [...document.querySelectorAll("#inquiry-preview mark")].map((m) => m.dataset.kind) } : null; })()`, 5_000, "age in preview").catch(() => null);
      await page.eval(`document.querySelector("#inquiry-prepare").click()`);
      const draft = await page.waitFor(`document.querySelector("#inquiry-draft")?.value ?? ""`, 5_000, "draft").catch(() => "");
      const inquiryLog = (await page.eval(`window.__chartstays.trustLog()`)).filter((e) => e.type === "inquiry");
      const ageLine = draft.split("\n").find((l) => l.includes("Age range:")) ?? "";
      const ageValue = ageLine.replace(/^.*Age range:\s*/, "");
      check(
        "w6 opted-in field appears in the preview and draft, not in the log",
        optIn !== null && optIn.marks.includes("age") && ageValue !== "" &&
          inquiryLog.some((e) => e.action === "opened" && e.nct_id === nct) &&
          inquiryLog.some((e) => e.action === "prepared" && JSON.stringify(e.fields) === JSON.stringify(["age"])) &&
          !JSON.stringify(inquiryLog).includes(ageValue),
        { optIn: optIn && { status: optIn.status, marks: optIn.marks }, ageLine, inquiryLog: inquiryLog.map((e) => `${e.action}:${(e.fields ?? []).join("+")}`) },
      );
      await page.eval(`document.querySelector("#inquiry-close").click()`);
      const newResources = await page.eval(`performance.getEntriesByType("resource").slice(${resourcesBefore}).map((e) => e.name).filter((n) => !n.startsWith(location.origin + "/"))`);
      const inquiryNodeReqs = await since();
      check("w6 prepareInquiry sends no request", newResources.length === 0 && inquiryNodeReqs.length === 0, { newResources, nodeRequests: inquiryNodeReqs.length });

      // Local model option: shown; in this headless Chrome, either the model panel (no download
      // without confirmation) or the no-WebGPU fallback.
      await page.eval(`document.querySelector("#agent-model-local").click()`);
      const local = await page.waitFor(`(() => {
        if (document.querySelector("#webllm-unsupported")) return { panel: "unsupported" };
        if (document.querySelector("#webllm-panel")) return { panel: "supported", options: [...document.querySelectorAll("#webllm-model option")].map((o) => o.textContent), download: document.querySelector("#webllm-download")?.textContent ?? "" };
        return null;
      })()`, 10_000, "local model panel").catch(() => null);
      // The worker loads under its own CSP and refuses a model outside its allow-list (no download).
      // Its requests are observed from inside the worker target (CDP auto-attach), not from the
      // page's performance entries, which never list a worker's fetches. Every Hugging Face request
      // is failed in the browser before it leaves, so no model is ever downloaded here.
      const hfBlock = await blockBrowserRequests(cdp, ["https://huggingface.co/*", "https://*.hf.co/*"]);
      const observed = await page.observeWorkers();
      const runWorker = (modelId) =>
        page.eval(`new Promise((resolve) => {
          const w = new Worker("/webllm/worker.js", { type: "module" });
          const t = setTimeout(() => { w.terminate(); resolve("timeout"); }, 20000);
          w.onmessage = (e) => { if (e.data.type === "progress") return; clearTimeout(t); w.terminate(); resolve(e.data.type + ": " + (e.data.message ?? "")); };
          w.onerror = (e) => { clearTimeout(t); w.terminate(); resolve("error: " + (e.message || "worker failed to load")); };
          w.postMessage({ type: "load", id: 1, modelId: ${JSON.stringify(modelId)} });
        })`);
      const worker = await runWorker("evil-model");
      await sleep(300);
      const evil = { workers: [...observed.workers], requests: [...observed.requests], blocked: [...hfBlock.blocked], setupErrors: [...observed.setupErrors] };
      const workerCsp = await fetch(`${APP}/webllm/worker.js`).then((r) => r.headers.get("content-security-policy") ?? "");
      const libCsp = await fetch(`${APP}/webllm/web-llm.js`).then((r) => (r.ok ? r.headers.get("content-security-policy") ?? "" : `HTTP ${r.status}`));
      const WEBLLM_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://*.aws.cdn.hf.co; worker-src 'none'";
      const offOrigin = evil.requests.filter((u) => !u.startsWith(`${APP}/`));
      check(
        "w6 local model option shown, worker under its own CSP",
        local !== null && (local.panel === "unsupported" || (local.options.length === 2 && local.options.every((o) => /\d(\.\d+)? (GB|MB) download/.test(o)) && /Download \d/.test(local.download))) &&
          worker === "error: Model evil-model is not allowed." && workerCsp === WEBLLM_CSP && libCsp === WEBLLM_CSP,
        { local, worker, workerCsp, libCsp },
      );
      check(
        "w6 worker requests observed in the worker target: a refused model fetches nothing",
        evil.setupErrors.length === 0 &&
          evil.workers.some((w) => w.type === "worker" && w.url === `${APP}/webllm/worker.js`) &&
          evil.requests.some((u) => u === `${APP}/webllm/web-llm.js`) &&
          offOrigin.length === 0 &&
          evil.blocked.length === 0 &&
          !evil.requests.some((u) => u.includes("/webllm/pins.json")),
        evil,
      );
      // An allowed model: the worker reads the pins from this site and asks Hugging Face for the
      // pinned revision only (resolve/<commit>/); that request is failed in the worker.
      const pins = JSON.parse(await readFile(path.join(ROOT, "apps/patient/public/webllm/pins.json"), "utf8"));
      const pin = pins.models["Qwen3-1.7B-q4f16_1-MLC"];
      const seenBefore = observed.requests.length;
      const allowed = await runWorker("Qwen3-1.7B-q4f16_1-MLC");
      await sleep(300);
      await hfBlock.stop();
      const allowedReqs = observed.requests.slice(seenBefore);
      const blocked = hfBlock.blocked;
      const libs = await Promise.all(
        Object.values(pins.models).map(async (m) => {
          const res = await fetch(`${APP}${m.wasm.path}`);
          const body = Buffer.from(await res.arrayBuffer());
          return { path: m.wasm.path, status: res.status, ok: res.ok && createHash("sha256").update(body).digest("hex") === m.wasm.sha256 };
        }),
      );
      check(
        "w6 worker fetches pinned revisions only; WebGPU libraries served from this site with pinned sha256",
        allowedReqs.includes(`${APP}/webllm/pins.json`) &&
          blocked.length > 0 &&
          blocked.every((u) => u.startsWith(pin.modelUrl)) &&
          blocked[0] === `${pin.modelUrl}tensor-cache.json` &&
          allowedReqs.filter((u) => !u.startsWith(`${APP}/`)).every((u) => u.startsWith(pin.modelUrl)) &&
          /^error: /.test(allowed) &&
          libs.every((l) => l.ok),
        { allowed, allowedReqs, blocked, libs },
      );
      await page.close();
    }

    // w6. Without WebGPU (navigator.gpu removed before the page runs), the fallback is shown.
    {
      const page = await newPage(cdp);
      await page.addInitScript(`Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true });`);
      await importHero(page);
      await openMatch(page);
      await page.eval(`document.querySelector("#agent-model-local").click()`);
      const fallback = await page.waitFor(`document.querySelector("#webllm-unsupported")?.innerText ?? ""`, 10_000, "WebGPU fallback").catch(() => "");
      const demoStill = await page.eval(`!!document.querySelector("#agent-model-demo") && !document.querySelector("#webllm-download")`);
      check("w6 no WebGPU: fallback shown, no download offered", /needs WebGPU/.test(fallback) && /demo model or your own key/i.test(fallback) && demoStill, { fallback: fallback.slice(0, 160), demoStill });
      // Every page of the app, for the CSP check below.
      for (const p of ["/", "/match"]) await page.goto(`${APP}${p}`);
      await sleep(500);
      await page.close();
      await since();
    }

    check("e no CSP violations on any page", CSP_VIOLATIONS.length === 0, { violations: CSP_VIOLATIONS.slice(0, 5) });

    // c. Over every node request made above.
    {
      const problems = checkRequests(allNodeRequests, terms);
      check("c no profile values, Authorization or Cookie in node requests", problems.length === 0 && allNodeRequests.length > 0, { requests: allNodeRequests.length, terms: terms.phrases.length + terms.tokens.length, problems: problems.slice(0, 10) });
    }

    // shady. Agent Firewall against the DEMO / ADVERSARIAL node: the same export served with the
    // config/nodes.demo.json overlay, and the nodes on 4101-4105.
    {
      await stopChild(nodes);
      nodes = null;
      await new Promise((r) => app.close(r));
      app = null;
      const overlay = path.join(tmp, "overlay");
      await writeOverlay(overlay);
      app = await serveApp(overlay);
      nodes = await startNodes(logFile, true);
      await since();
      const cspBefore = CSP_VIOLATIONS.length;
      const csp = await fetch(`${APP}/match`).then((r) => r.headers.get("content-security-policy") ?? "");
      const shadyRequests = [];
      let exfilLink = { defaultAllowed: true, stayed: false, logged: false };

      // b2. A question with health data for the shady node's assistant is blocked before anything is sent.
      {
        const page = await newPage(cdp);
        await importHero(page);
        await since();
        await openMatch(page, 5);
        await page.eval(`document.querySelector("#start-agent").click()`);
        await page.waitFor(`!!document.querySelector("#ns-input") && document.querySelector("#agent-app").dataset.state === "ready"`, 30_000, "agent runtime");
        const condition = terms.phrases.find((p) => terms.kinds[p] === "condition") ?? terms.phrases[0];
        const question = `Do you have trials for ${condition}?`;
        const decision = await page.eval(
          `window.__nsweb.engine.onConsent({ kind: "network", peerOrigin: "localhost:4105", peerLabel: "DEMO / ADVERSARIAL shady node (network shady_demo_trials)", requestText: ${JSON.stringify(question)} })`,
        );
        const dialogOpened = await page.eval(`document.querySelector("#consent-dialog")?.open === true`);
        const log = await page.eval(`window.__chartstays.trustLog()`);
        const phiBlock = log.filter((e) => e.type === "firewall" && e.origin === SHADY && e.rule === "out.phi" && e.action === "blocked");
        const reqs = await since();
        shadyRequests.push(...reqs);
        // The question's detected value never reaches the log (only its kind does).
        const loggedValue = JSON.stringify(log).toLowerCase().includes(condition.toLowerCase());
        const redacted = phiBlock[0]?.redacted?.map((s) => s.text).join("") ?? "";
        const blockRow = await page.eval(`(() => {
          const tr = document.querySelector('.trust-origin[data-origin="${SHADY}"] tr[data-action="blocked"][data-rule="out.phi"]');
          return tr ? { text: tr.innerText.replace(/\\s+/g, " "), highlighted: [...tr.querySelectorAll("mark, .phi-mark, [data-kind]")].length } : null;
        })()`);
        check(
          "shady b requestText with health data blocked before sending",
          decision === "decline" && !dialogOpened && phiBlock.length === 1 && !reqs.some((r) => r.port === 4105) && !loggedValue && redacted.includes("[condition]") && blockRow !== null && blockRow.highlighted > 0 && !blockRow.text.toLowerCase().includes(condition.toLowerCase()),
          { decision, dialogOpened, phiBlocks: phiBlock.length, redacted, shadyRequests: reqs.filter((r) => r.port === 4105).length, loggedValue, blockRow },
        );

        // The manual scanner highlights the same text locally, with a text status, and logs nothing.
        const before = (await page.eval(`window.__chartstays.trustLog()`)).length;
        await page.eval(`(() => {
          const t = document.querySelector("#scan-text");
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ${JSON.stringify(question)});
          t.dispatchEvent(new Event("input", { bubbles: true }));
        })()`);
        await page.eval(`document.querySelector("#scan-run").click()`);
        const scan = await page.waitFor(
          `(() => { const s = document.querySelector("#scan-status"); return s ? { status: s.dataset.status, label: s.textContent, live: s.closest("[aria-live]")?.getAttribute("aria-live") ?? null, kinds: [...document.querySelectorAll("#scan-highlight mark")].map((m) => m.dataset.kind) } : null; })()`,
          5_000,
          "scan result",
        ).catch(() => null);
        const after = (await page.eval(`window.__chartstays.trustLog()`)).length;
        check("shady PHI scanner highlights with kind and text status, logs nothing", scan?.status === "blocked" && scan.kinds.includes("condition") && /^Blocked/.test(scan.label) && scan.live === "polite" && after === before, { scan, logged: after - before });

        // c1. The shady node's exfiltration link, if it reached the assistant's output, is refused when clicked.
        const exfil = "https://exfil.shady.example/collect?dx={diagnosis}&age={age}";
        const link = await page.eval(`(() => {
          const a = document.createElement("a");
          a.href = ${JSON.stringify(exfil)};
          a.textContent = "check eligibility";
          document.querySelector("#agent-app").append(a);
          const before = location.href;
          const clicked = a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          a.remove();
          return { defaultAllowed: clicked, stayed: location.href === before };
        })()`);
        await sleep(200);
        const linkLog = (await page.eval(`window.__chartstays.trustLog()`)).filter((e) => e.type === "link" && e.origin === "https://exfil.shady.example");
        exfilLink = { ...link, logged: linkLog.some((e) => e.decision === "blocked") };
        await page.close();
      }

      // a, c, d, e. Find trials with consent to every node, the shady one included.
      {
        const page = await newPage(cdp);
        await importHero(page);
        await since();
        await openMatch(page, 5);
        const run = await findTrials(page, () => "allow_once");
        const reqs = await since();
        shadyRequests.push(...reqs);
        const log = await page.eval(`window.__chartstays.trustLog()`);
        const fw = log.filter((e) => e.type === "firewall" && e.origin === SHADY);
        const shadyState = await page.eval(`document.querySelector('#node-list li[data-origin="${SHADY}"]')?.dataset.status ?? ""`);
        const shown = await page.eval(`[document.querySelector('#node-list li[data-origin="${SHADY}"]')?.innerText ?? "", document.querySelector("#results")?.textContent ?? ""].join("\\n")`);
        const shadyRows = run.rows.filter((r) => /^NCT999999/.test(r.nct));
        check(
          "shady a consent given: injection neutralized, node quarantined",
          run.decisions.some((d) => d.origin === SHADY) && shadyState === "quarantined" && fw.some((e) => e.rule === "in.injection" && e.action === "quarantined") && shadyRows.length === 0 && !/ignore previous instructions/i.test(shown),
          { shadyState, rules: [...new Set(fw.map((e) => `${e.rule}:${e.action}`))], shadyRows: shadyRows.length },
        );

        // c. The shady node's exfiltration link: flagged in its content (and refused when clicked, above).
        check(
          "shady c exfil link blocked",
          fw.some((e) => e.rule === "in.exfil-url") && exfilLink.defaultAllowed === false && exfilLink.stayed && exfilLink.logged && !reqs.some((r) => /exfil/.test(r.url)),
          { exfilFindings: fw.filter((e) => e.rule === "in.exfil-url").map((e) => e.field), exfilLink },
        );

        // d. The trust panel.
        const panel = await page.eval(`(() => {
          const s = document.querySelector("#trust-summary");
          const o = document.querySelector('.trust-origin[data-origin="${SHADY}"]');
          return {
            summary: s?.textContent ?? "",
            fields: s?.dataset.fields,
            blocked: s?.dataset.blocked,
            quarantined: o?.dataset.quarantined,
            note: o?.querySelector(".quarantine-note")?.textContent ?? "",
            actions: [...(o?.querySelectorAll(".trust-firewall tr[data-action]") ?? [])].map((tr) => tr.dataset.action),
          };
        })()`);
        check(
          "shady d trust panel: blocks, quarantine, Patient data sent: 0",
          panel.summary.startsWith("Patient data sent: 0 fields") && panel.fields === "0" && Number(panel.blocked) > 0 && panel.quarantined === "true" && panel.note.includes("QUARANTINED") && panel.actions.includes("quarantined") && panel.actions.includes("neutralized"),
          panel,
        );

        // e. The four real nodes still give the verdicts in docs/match-matrix.md.
        const got = Object.fromEntries(run.rows.map((r) => [r.nct, r.verdict]));
        const mismatches = Object.entries(expected).filter(([nct, v]) => got[nct] !== v).map(([nct, v]) => `${nct}: expected ${v}, got ${got[nct]}`);
        check("shady e real nodes' verdicts match docs/match-matrix.md", run.rows.length === 20 && mismatches.length === 0, { rows: run.rows.length, mismatches });
        await page.close();
      }

      const problems = checkRequests(shadyRequests.filter((r) => r.port === 4105), terms);
      check("shady b no 4105 request carries profile values", problems.length === 0, { requests: shadyRequests.filter((r) => r.port === 4105).map((r) => r.url), problems });
      check(
        "shady f 0 CSP violations, CSP unchanged but for the demo origin",
        CSP_VIOLATIONS.length === cspBefore && csp.includes(`${SHADY} `) && !/unsafe-eval/.test(csp) && /script-src 'self'( 'sha256-[^']+')+;/.test(csp),
        { violations: CSP_VIOLATIONS.slice(cspBefore, cspBefore + 5) },
      );
    }

    // s6. Spec §6 interop: TEST-ONLY fixture nodes and a BYOK setup with a local fake router.
    {
      await stopChild(nodes);
      nodes = null;
      await new Promise((r) => app.close(r));
      app = null;
      const fixtureDir = path.join(tmp, "interop-fixtures");
      const fixtureLog = path.join(tmp, "fixtures.log");
      await writeFile(fixtureLog, "");
      const configPath = await writeFixtures(fixtureDir);
      const overlay = path.join(tmp, "interop-overlay");
      await writeOverlay(overlay, configPath);
      app = await serveApp(overlay);
      nodes = await startNodes(logFile);
      closeFixtures = await serveFixtures(fixtureDir, { logFile: fixtureLog });
      fakeRouter = await startFakeRouter();
      await since();
      const cspBefore = CSP_VIOLATIONS.length;
      const csp = await fetch(`${APP}/match`).then((r) => r.headers.get("content-security-policy") ?? "");
      const KEY = `sk-chartstays-e2e-${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 24)}`;
      const page = await newPage(cdp);
      // The BYOK setup the runtime's ⚙ AI model settings would save for this tab (public/runtime/byok.js).
      await page.addInitScript(`try {
        sessionStorage.setItem("nsweb-byok-tab-key", ${JSON.stringify(KEY)});
        sessionStorage.setItem("nsweb-byok-model", ${JSON.stringify(FAKE_MODEL)});
        sessionStorage.setItem("nsweb-byok-router", ${JSON.stringify(FAKE_ROUTER)});
      } catch {}`);
      await importHero(page);
      await since();
      await openMatch(page, 6);
      await page.eval(`document.querySelector("#start-agent").click()`);
      await page.waitFor(`!!document.querySelector("#ns-input") && document.querySelector("#agent-app").dataset.state === "ready"`, 30_000, "agent runtime (BYOK)").catch(async (error) => {
        const alert = await page.eval(`document.querySelector("[role=alert]")?.textContent ?? ""`).catch(() => "");
        throw new Error(`${error.message}: ${JSON.stringify({ alert, pageErrors: page.errors.slice(0, 3) })}`);
      });
      const problems = () => page.eval(`[...document.querySelectorAll("#agent-problems li")].map((li) => ({ kind: li.dataset.kind, where: li.dataset.where, text: li.textContent }))`);
      const chat = async (text, until, what) => {
        const answers = answerDialogs(page, () => "allow_once");
        try {
          await page.eval(`(() => { const i = document.querySelector("#ns-input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#ns-send").click(); })()`);
          await page.waitFor(`document.querySelector(".ns-inputbar")?.dataset.turnActive === "true"`, 10_000, "turn start").catch(() => undefined);
          await page.waitFor(`document.querySelector(".ns-inputbar")?.dataset.turnActive === "false"`, 120_000, what);
          await page.waitFor(until, 5_000, `${what}: problems shown`).catch(() => undefined);
        } finally {
          await answers.stop();
        }
        return answers.decisions;
      };

      // Turn 1: router, named, invalid and cycle are tried; budget and t2d are over the third-party budget.
      const decisions1 = await chat("Which studies do you list here?", `document.querySelectorAll("#agent-problems li[data-kind=budget]").length > 0`, "interop turn 1");
      const shown1 = await problems();
      const has = (list, kind, re) => list.some((p) => p.kind === kind && re.test(p.text));
      check(
        "s6 4 exact network name: a mismatch fails with a visible message",
        has(shown1, "peer_failed", /No published network named 'fixture_named' at localhost:4109; refusing to run a different network/),
        { shown: shown1.map((p) => `${p.kind}: ${p.text.slice(0, 120)}`) },
      );
      check(
        "s6 7 invalid network refused with a visible message",
        has(shown1, "peer_failed", /Network 'fixture_invalid' \(localhost:4106\) failed validation: .*Every agent must have a 'name'/),
        { invalid: shown1.filter((p) => /4106/.test(p.text + p.where)).map((p) => p.text.slice(0, 200)) },
      );
      check(
        "s6 7 composition cycle skipped with a visible message",
        has(shown1, "cycle", new RegExp(`${FIXTURE_ORIGINS.cycle}/fixture_cycle.*composition cycle`)),
        { cycle: shown1.filter((p) => p.kind === "cycle").map((p) => p.text) },
      );
      check(
        "s6 7 third-party budget: the 5th peer is skipped with a visible message",
        has(shown1, "budget", /per-query limit of 4 third-party calls/),
        { budget: shown1.filter((p) => p.kind === "budget").map((p) => p.text) },
      );
      const fixtureReqs1 = await readLog(fixtureLog);
      check(
        "s6 7 origin outside the directory refused, gets 0 requests",
        has(shown1, "refused", /localhost:4111.*not a trial node in the directory/) && !fixtureReqs1.some((r) => r.port === FIXTURE_PORTS.unlisted),
        { refused: shown1.filter((p) => p.kind === "refused").map((p) => p.text), requests4111: fixtureReqs1.filter((r) => r.port === FIXTURE_PORTS.unlisted).length },
      );
      const sessions = await page.eval(`[...window.__nsweb.engine.registry.cache.entries()].map(([key, s]) => ({ key, router: s.llm?.baseUrl, mock: s.llm?.mock, manifestKeys: Object.keys(s.manifest ?? {}) }))`);
      const routerSession = sessions.find((s) => s.key.startsWith(`${FIXTURE_ORIGINS.router}::`));
      check(
        "s6 5 node manifest's llm_router ignored: the peer runs on the visitor's router",
        routerSession !== undefined && routerSession.router === FAKE_ROUTER && routerSession.mock === false && !routerSession.manifestKeys.some((k) => /router|llm|byok/i.test(k)) &&
          !fixtureReqs1.some((r) => r.url.startsWith("/hijack")),
        { sessions, hijackRequests: fixtureReqs1.filter((r) => r.url.startsWith("/hijack")).length },
      );

      // Turn 2: the first four peers are skipped by the fake router; fixture_budget uses up the 24 agent calls.
      const decisions2 = await chat(
        // One short "skip:" word per peer: a 63-character word is refused by the firewall (out.long-token).
        "Which studies do you list here? skip:fixture_router skip:fixture_named skip:fixture_invalid skip:fixture_cycle",
        `[...document.querySelectorAll("#agent-problems li[data-kind=budget]")].some((li) => /agent invocations/.test(li.textContent))`,
        "interop turn 2",
      );
      const shown2 = (await problems()).filter((p) => !shown1.some((q) => q.kind === p.kind && q.text === p.text));
      const routerTurn = (r) => {
        try {
          const b = JSON.parse(r.body);
          const users = (b.messages ?? []).filter((m) => m.role === "user");
          return { user: String(users.at(-1)?.content ?? "").slice(0, 80), tools: (b.tools ?? []).map((t) => t.function?.name) };
        } catch {
          return null;
        }
      };
      check("s6 7 agent budget: a query over 24 agent calls is cut off with a visible message", has(shown2, "budget", /per-query limit of 24 agent invocations/), {
        newProblems: shown2.map((p) => `${p.kind}: ${p.text.slice(0, 160)}`),
        decisions2: decisions2.map((d) => d.origin),
        lastRouterCalls: fakeRouter.requests.filter((r) => r.method === "POST").slice(-4).map(routerTurn),
      });

      // BYOK: the key reaches the fake router only.
      const log = await page.eval(`window.__chartstays.trustLog()`);
      const routerEvents = log.filter((e) => e.type === "router");
      const modelHosts = await page.eval(`[...new Set(window.__nsweb.trace.events.filter((e) => e.phase === "start" && e.kind === "model_call").map((e) => e.routerHost))]`);
      const routerPosts = fakeRouter.requests.filter((r) => r.method === "POST");
      const nodeReqs = [...(await since()), ...(await readLog(fixtureLog))];
      const carriesKey = (r) => JSON.stringify([r.url, r.headers, r.body]).includes(KEY);
      check(
        "s6 2 BYOK: model calls go to the visitor's router with the key",
        // The panel logs the boot router as a URL and each model call's router as a host (trace routerHost).
        routerEvents.length > 0 && routerEvents.every((e) => (e.router === FAKE_ROUTER || e.router === new URL(FAKE_ROUTER).host) && e.mock === false) &&
          JSON.stringify(modelHosts) === JSON.stringify(["localhost:11434"]) && routerPosts.length > 0 && routerPosts.every((r) => r.headers.authorization === `Bearer ${KEY}`),
        { routerEvents, modelHosts, routerPosts: routerPosts.length, withoutKey: routerPosts.filter((r) => r.headers.authorization !== `Bearer ${KEY}`).length },
      );
      check(
        "s6 5 BYOK key never sent to a node (url, headers, body), no Authorization to nodes",
        nodeReqs.length > 0 && !nodeReqs.some(carriesKey) && checkRequests(nodeReqs, terms).length === 0,
        { nodeRequests: nodeReqs.length, withKey: nodeReqs.filter(carriesKey).map((r) => `${r.port}${r.url}`), problems: checkRequests(nodeReqs, terms).slice(0, 5) },
      );
      check(
        "s6 consent asked for each listed peer before contact; 0 CSP violations",
        [FIXTURE_ORIGINS.router, FIXTURE_ORIGINS.named, FIXTURE_ORIGINS.invalid, FIXTURE_ORIGINS.cycle].every((o) => decisions1.some((d) => d.origin === o)) &&
          decisions2.some((d) => d.origin === FIXTURE_ORIGINS.budget) && CSP_VIOLATIONS.length === cspBefore && csp.includes("connect-src 'self' http://localhost:4110") && !/unsafe-eval/.test(csp),
        { decisions1: decisions1.map((d) => d.origin), decisions2: decisions2.map((d) => d.origin), violations: CSP_VIOLATIONS.slice(cspBefore, cspBefore + 5) },
      );
      await page.close();
    }
  } finally {
    if (closeFixtures) await closeFixtures();
    if (fakeRouter) await fakeRouter.close();
    cdp?.close();
    if (chrome) {
      chrome.child.kill("SIGTERM");
      await sleep(500);
      if (chrome.child.exitCode === null) chrome.child.kill("SIGKILL");
    }
    if (nodes) await stopChild(nodes);
    if (app) await new Promise((r) => app.close(r));
    await rm(tmp, { recursive: true, force: true });
  }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} ${JSON.stringify(r.detail)}`);
  if (failures.length) {
    console.error(`E2E failed: ${failures.length} check(s).`);
    process.exitCode = 1;
  } else {
    console.log("E2E passed.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
