// Week 4 site actions: readProfile allow-list, loadNode validation and consent, local-only
// evaluateCriteria, the runtime consent gate and the site-actions.js adapter.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { validateCriteria } from "@chartstays/criteria-schema";
import { parseBundleText } from "@chartstays/fhir-profile";
import { ConsentManager } from "../lib/consent.ts";
import { parseDirectory } from "../lib/directory.ts";
import { LIMITS } from "../lib/node-loader.ts";
import { profileTerms } from "../lib/phi-scan.ts";
import { summarizeProfile } from "../lib/profile-summary.ts";
import { createConsentGate, lockConsentGate, MAX_PEER_REQUEST } from "../lib/runtime-consent.ts";
import { createSiteActions } from "../lib/site-actions.ts";
import { TrialSession } from "../lib/trial-session.ts";
import { TrustLog } from "../lib/trust-log.ts";

const ROOT = new URL("../../../", import.meta.url);
const NODE_DIR = new URL("dist/nodes/type-2-diabetes/", ROOT);
const ORIGIN = "http://localhost:4101";
const OTHER = "http://localhost:4102";

const demo = JSON.parse(await readFile(new URL("data/demo-patients.json", ROOT), "utf8"));
const hero = demo.patients.find((p) => p.id === "demo-type-2-diabetes");
const PROFILE = parseBundleText(await readFile(new URL(`data/synthea/shifted/${hero.file}`, ROOT), "utf8"), { asOf: new Date(`${demo.asOf}T12:00:00Z`) });

const DIRECTORY = parseDirectory({
  version: 1,
  nodes: [
    { name: "T2D node", origin: ORIGIN, area: "type-2-diabetes", network: "t2d_trials" },
    { name: "Breast cancer node", origin: OTHER, area: "breast-cancer", network: "breast_cancer_trials" },
  ],
});

/** Files of the generated t2d node, served for both test origins (the second with its own network). */
async function nodeFiles() {
  const files = new Map();
  const manifest = await readFile(new URL("agent-manifest.json", NODE_DIR), "utf8");
  const index = await readFile(new URL("criteria/index.json", NODE_DIR), "utf8");
  files.set(`${ORIGIN}/agent-manifest.json`, manifest);
  files.set(`${ORIGIN}/criteria/index.json`, index);
  for (const f of (await readdir(new URL("criteria/", NODE_DIR))).filter((f) => /^NCT\d{8}\.json$/.test(f))) {
    files.set(`${ORIGIN}/criteria/${f}`, await readFile(new URL(`criteria/${f}`, NODE_DIR), "utf8"));
  }
  return files;
}

function fakeFetch(files) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = files.get(String(url));
    if (body === undefined) return new Response("Not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

function setup({ files, prompt = async () => "allow_session", profile = PROFILE } = {}) {
  const log = new TrustLog();
  const consent = new ConsentManager(log);
  if (prompt !== null) consent.setPrompt(prompt);
  const fetcher = fakeFetch(files);
  const session = new TrialSession({
    directory: async () => DIRECTORY,
    profile: async () => profile,
    consent,
    loader: { fetch: fetcher.fn, validate: validateCriteria },
    log,
  });
  const actions = Object.fromEntries(createSiteActions(session, async () => profile, log).map((a) => [a.name, a]));
  return { log, consent, session, actions, calls: fetcher.calls };
}

test("readProfile returns only allow-listed fields", async () => {
  const tainted = {
    ...PROFILE,
    name: "Angelyn Harris",
    address: "1 Main St",
    identifier: "MRN-123",
    conditions: [
      ...PROFILE.conditions,
      { system: "http://snomed.info/sct", code: "160903007", display: "Full-time employment (finding)", onset: null, abatement: null, active: true },
      { system: "http://snomed.info/sct", code: "999999", display: "Suspected thing (disorder)", onset: null, abatement: null, active: false, unconfirmed: true },
      { system: "http://example.org/local", code: "X1", display: "Local code (disorder)", onset: null, abatement: null, active: true },
    ],
    observations: { ...PROFILE.observations, "72166-2": { value: "Never smoked", unit: null, date: "2026-01-02", display: "Tobacco smoking status" } },
  };
  const { actions } = setup({ files: await nodeFiles(), profile: tainted });
  await actions.loadNode.execute({ origin: ORIGIN });
  const summary = await actions.readProfile.execute({});
  assert.deepEqual(Object.keys(summary).sort(), ["ageBand", "conditions", "labs", "medications", "note", "sex"]);
  assert.match(summary.ageBand, /^\d+-\d+$/);
  const text = JSON.stringify(summary);
  for (const banned of ["Angelyn", "Main St", "MRN-123", "employment", "Suspected", "Local code", "Never smoked", PROFILE.asOf]) {
    assert.ok(!text.includes(banned), `summary leaks ${banned}`);
  }
  for (const c of summary.conditions) assert.deepEqual(Object.keys(c).sort(), ["code", "display", "system"]);
  for (const l of summary.labs) {
    assert.deepEqual(Object.keys(l).sort(), ["loinc", "month", "name", "unit", "value"]);
    assert.match(l.month, /^\d{4}-\d{2}$/);
  }
  for (const m of summary.medications) assert.deepEqual(Object.keys(m).sort(), ["display", "rxnorm"]);
  assert.ok(summary.conditions.some((c) => /diabetes/i.test(c.display)));
  assert.equal(summary.ageBand, `${Math.floor(PROFILE.age / 5) * 5}-${Math.floor(PROFILE.age / 5) * 5 + 4}`);
});

test("loadNode loads a valid node after consent, without credentials or referrer", async () => {
  const { actions, calls } = setup({ files: await nodeFiles() });
  const result = await actions.loadNode.execute({ origin: ORIGIN });
  assert.equal(result.status, "loaded");
  assert.equal(result.studies, 5);
  assert.equal(result.rejected, 0);
  assert.ok(calls.length >= 7);
  for (const { url, init } of calls) {
    assert.ok(url.startsWith(`${ORIGIN}/`));
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers, undefined);
    assert.equal(init.body, undefined);
  }
});

test("loadNode rejects a study whose criteria fail the schema, keeping the others", async () => {
  const files = await nodeFiles();
  const [first] = [...files.keys()].filter((k) => /NCT\d{8}\.json$/.test(k));
  const doc = JSON.parse(files.get(first));
  delete doc.structured;
  files.set(first, JSON.stringify(doc));
  const { actions, session } = setup({ files });
  const result = await actions.loadNode.execute({ origin: ORIGIN });
  assert.equal(result.status, "loaded");
  assert.equal(result.studies, 4);
  assert.equal(result.rejected, 1);
  assert.match(session.state(ORIGIN).rejected[0].reason, /schema/);
});

test("loadNode rejects a node whose manifest does not publish the exact network name", async () => {
  const files = await nodeFiles();
  const manifest = JSON.parse(files.get(`${ORIGIN}/agent-manifest.json`));
  manifest.networks[0].name = "t2d_trials_v2";
  files.set(`${ORIGIN}/agent-manifest.json`, JSON.stringify(manifest));
  const { actions, calls } = setup({ files });
  const result = await actions.loadNode.execute({ origin: ORIGIN });
  assert.equal(result.status, "error");
  assert.match(result.message, /exact name/);
  assert.equal(calls.length, 1, "nothing else is fetched from a mismatched node");
});

test("loadNode rejects an oversized response", async () => {
  const files = await nodeFiles();
  const index = JSON.parse(files.get(`${ORIGIN}/criteria/index.json`));
  index.padding = "x".repeat(LIMITS.indexBytes + 10);
  files.set(`${ORIGIN}/criteria/index.json`, JSON.stringify(index));
  const { actions } = setup({ files });
  const result = await actions.loadNode.execute({ origin: ORIGIN });
  assert.equal(result.status, "error");
  assert.match(result.message, /larger than/);
});

test("loadNode refuses criteria paths on another origin", async () => {
  const files = await nodeFiles();
  const index = JSON.parse(files.get(`${ORIGIN}/criteria/index.json`));
  index.studies[0].criteria = "https://evil.example/criteria/x.json";
  files.set(`${ORIGIN}/criteria/index.json`, JSON.stringify(index));
  const { actions, calls } = setup({ files });
  const result = await actions.loadNode.execute({ origin: ORIGIN });
  assert.equal(result.rejected, 1);
  assert.ok(calls.every((c) => c.url.startsWith(`${ORIGIN}/`)));
});

test("loadNode contacts nothing outside the directory", async () => {
  const { actions, calls } = setup({ files: await nodeFiles() });
  await assert.rejects(actions.loadNode.execute({ origin: "https://unknown.example" }), /not the origin of a trial node/);
  // Same host, other scheme: not the directory's exact origin.
  await assert.rejects(actions.loadNode.execute({ origin: "https://localhost:4101" }), /not the origin of a trial node/);
  assert.equal(calls.length, 0);
  // A trailing slash or path is normalized to the directory origin.
  const result = await actions.loadNode.execute({ origin: `${ORIGIN}/` });
  assert.equal(result.status, "loaded");
});

test("without a consent dialog every node is denied and nothing is fetched", async () => {
  const { actions, calls, log } = setup({ files: await nodeFiles(), prompt: null });
  const result = await actions.loadNode.execute({ origin: ORIGIN });
  assert.equal(result.status, "denied");
  assert.equal(result.message, `Access to ${ORIGIN} denied`);
  assert.equal(calls.length, 0);
  assert.ok(log.events().some((e) => e.type === "consent" && e.decision === "deny"));
});

test("a denied node gets no request and the other node still loads", async () => {
  const files = await nodeFiles();
  // Serve the same studies as a second node under its own network name.
  for (const [url, body] of [...files]) {
    let text = body;
    if (url.endsWith("agent-manifest.json")) text = body.replaceAll('"t2d_trials"', '"breast_cancer_trials"');
    if (url.endsWith("criteria/index.json")) text = body.replace('"network": "t2d_trials"', '"network": "breast_cancer_trials"').replace('"network":"t2d_trials"', '"network":"breast_cancer_trials"');
    files.set(url.replace(ORIGIN, OTHER), text);
  }
  const { session, calls } = setup({ files, prompt: async (req) => (req.origin === ORIGIN ? "deny" : "allow_once") });
  const run = await session.findAll();
  assert.equal(calls.filter((c) => c.url.startsWith(ORIGIN)).length, 0);
  assert.ok(calls.some((c) => c.url.startsWith(OTHER)));
  assert.equal(run.rows.length, 5);
  assert.deepEqual(run.missing.map((m) => [m.origin, m.message]), [[ORIGIN, `Access to ${ORIGIN} denied`]]);
});

test("evaluateCriteria and buildDoctorSheet never touch the network", async () => {
  const { actions, calls } = setup({ files: await nodeFiles() });
  await actions.loadNode.execute({ origin: ORIGIN });
  const before = calls.length;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network used");
  };
  try {
    const result = await actions.evaluateCriteria.execute({});
    const sheet = await actions.buildDoctorSheet.execute({});
    assert.equal(calls.length, before);
    assert.equal(result.total, 5);
    assert.equal(result.shown, 5);
    assert.equal(Object.values(result.byVerdict).reduce((a, b) => a + b, 0), 5);
    for (const r of result.results) {
      assert.match(r.title, /^<<node_text>>[\s\S]*<<\/node_text>>$/);
      for (const reason of r.reasons) assert.match(reason, /^<<node_text>>[\s\S]*<<\/node_text>>$/);
    }
    assert.match(result.note, /untrusted/);
    const byId = Object.fromEntries(result.results.map((r) => [r.nct_id, r.verdict]));
    for (const id of hero.strong_match) assert.equal(byId[id], "strong_match");
    for (const id of hero.not_eligible) assert.equal(byId[id], "not_eligible");
    assert.ok(JSON.stringify(result).length < 65536, "fits the runtime's 64 KB action limit");
    assert.match(sheet.sheet, /to confirm with your doctor/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("runtime consent gate: directory nodes only, health data blocked, never 'always', locked", async () => {
  const log = new TrustLog();
  const consent = new ConsentManager(log);
  const asked = [];
  consent.setPrompt(async (req) => {
    asked.push(req);
    return "allow_session";
  });
  const gate = createConsentGate({ consent, directory: DIRECTORY, log, terms: async () => profileTerms(PROFILE) });
  const label = "T2D node (network t2d_trials)";
  const ask = (requestText, extra = {}) => gate({ kind: "network", peerOrigin: "localhost:4101", peerLabel: label, requestText, ...extra });
  assert.equal(await gate({ kind: "network", peerOrigin: "evil.example", peerLabel: label, requestText: "hi" }), "decline");
  assert.equal(await gate({ kind: "mcp", peerOrigin: "localhost:4101", peerLabel: label, requestText: "hi" }), "decline");
  // Exact origin: same host on another scheme or port is not the node.
  assert.equal(await ask("hi", { peerOrigin: "https://localhost:4101" }), "decline");
  assert.equal(await ask("hi", { peerOrigin: "localhost:4109" }), "decline");
  // The network the runtime asks for must be the directory's.
  assert.equal(await ask("hi", { peerLabel: "T2D node (network other_net)" }), "decline");
  assert.equal(await ask("hi", { peerLabel: "T2D node" }), "decline");
  // Longer than 140 characters.
  assert.equal(await ask(`Where are the study sites? ${"x".repeat(MAX_PEER_REQUEST)}`), "decline");
  const condition = PROFILE.conditions.find((c) => c.active && /diabetes/i.test(c.display));
  assert.equal(await ask(`Patient has ${condition.display}`), "decline");
  assert.equal(await ask(`code ${condition.code}`), "decline");
  assert.equal(await ask("Any trials for T2D?"), "decline");
  assert.equal(await ask(`Trials for someone aged ${PROFILE.age}?`), "decline");
  assert.equal(asked.length, 0, "blocked requests never reach the dialog");
  assert.ok(log.events().filter((e) => e.type === "consent" && e.decision === "blocked").length >= 10);
  assert.equal(await ask("Where are the study sites?"), "allow");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].requestText, "Where are the study sites?");
  assert.equal(asked[0].network, "t2d_trials");
  // After "Allow for this session" each question is still logged with its full text.
  assert.equal(await ask("How long does a visit take?"), "allow");
  assert.equal(asked.length, 1);
  assert.ok(log.events().some((e) => e.type === "consent" && e.decision === "remembered" && e.requestText === "How long does a visit take?"));
  // Revoking asks again.
  assert.equal(consent.revoke(ORIGIN, "t2d_trials"), true);
  assert.equal(await ask("How long does a visit take?"), "allow");
  assert.equal(asked.length, 2);

  const engine = { onConsent: async () => "always" };
  lockConsentGate(engine, gate);
  assert.equal(engine.onConsent, gate);
  assert.throws(() => {
    "use strict";
    engine.onConsent = async () => "always";
  }, TypeError);
});

test("site-actions.js registers the page's actions and fails closed without them", async () => {
  const { registerActions } = await import("../public/site-actions.js");
  delete globalThis.__chartstaysSiteActions;
  await assert.rejects(registerActions({ register: () => assert.fail("must not register") }), /not available/);
  const registered = [];
  globalThis.__chartstaysSiteActions = [{ name: "readProfile" }];
  await registerActions({ register: (d) => registered.push(d.name) });
  assert.deepEqual(registered, ["readProfile"]);
  delete globalThis.__chartstaysSiteActions;
});
