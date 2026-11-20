// Spec §6 interop (docs/interop-s6.md): the assistant's problems are shown in words, the test
// fixture nodes need a config marked "test", and a peer manifest never chooses the LLM router.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { problemFromFirewall, problemFromTrace, problemKey } from "../lib/agent-problems.ts";
import { AgentFirewall } from "../lib/firewall.ts";
import { sanitizePeerManifest } from "../lib/peer-fetch.ts";
import { TrustLog } from "../lib/trust-log.ts";
import { FIXTURE_ORIGINS, FIXTURES, HIJACK_ROUTER, interopConfig } from "../../../tools/e2e/interop-fixtures.mjs";

const APP = new URL("../", import.meta.url);

test("problemFromTrace: failed peer fetch, tool and model calls, budgets and cycles", () => {
  const peer = problemFromTrace({ phase: "end", kind: "remote_fetch", status: "error", peerOrigin: "localhost:4109", url: "http://localhost:4109/fixture_named", error: "No published network named 'fixture_named' at localhost:4109; refusing to run a different network." });
  assert.equal(peer?.kind, "peer_failed");
  assert.match(peer.message, /No published network named 'fixture_named'/);
  const tool = problemFromTrace({ phase: "end", kind: "tool", status: "error", tool: "fixture_named", origin: "localhost:4000", error: peer.error });
  assert.equal(tool?.kind, "tool_failed");
  // The same runtime error reported by the fetch and by the tool call is shown once.
  assert.equal(problemKey(peer), problemKey(tool));
  const budget = problemFromTrace({ phase: "note", kind: "composition_limit", target: "http://localhost:4108/fixture_budget", reason: "the per-query limit of 4 third-party calls was reached" });
  assert.equal(budget?.kind, "budget");
  assert.match(budget.message, /^Skipped http:\/\/localhost:4108\/fixture_budget: the per-query limit of 4/);
  const agents = problemFromTrace({ phase: "note", kind: "composition_limit", agent: "leaf_3_2", reason: "the per-query limit of 24 agent invocations was reached" });
  assert.match(agents?.message ?? "", /leaf_3_2: the per-query limit of 24 agent invocations/);
  const cycle = problemFromTrace({ phase: "note", kind: "composition_skip", target: "http://localhost:4107/fixture_cycle", reason: "already visited in this request" });
  assert.equal(cycle?.kind, "cycle");
  assert.match(cycle.message, /composition cycle/);
  const model = problemFromTrace({ phase: "end", kind: "model_call", status: "error", routerHost: "localhost:11434", error: "LLM HTTP 401: bad key" });
  assert.equal(model?.kind, "model_failed");
  assert.equal(problemFromTrace({ phase: "end", kind: "tool", status: "ok" }), null);
  assert.equal(problemFromTrace({ phase: "note", kind: "consent" }), null);
  assert.ok(problemFromTrace({ phase: "end", kind: "tool", status: "error", error: "x".repeat(2000) }).message.length <= 400);
});

test("a hand-off to an origin outside the directory is removed by the firewall and shown as refused", () => {
  const log = new TrustLog();
  const entries = [];
  log.subscribe((e) => e !== null && entries.push(e));
  const firewall = new AgentFirewall({ log });
  const invalid = FIXTURES.find((f) => f.key === "invalid");
  const doc = invalid.files()["fixture_invalid.network.json"];
  // The same file kind lib/peer-fetch.ts uses for a node's *.network.json.
  const inspected = firewall.inspectJson(FIXTURE_ORIGINS.invalid, "network.json", doc);
  assert.ok(!JSON.stringify(inspected.value.tools).includes(FIXTURE_ORIGINS.unlisted));
  const refused = entries.map(problemFromFirewall).filter((p) => p !== null);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].kind, "refused");
  assert.equal(refused[0].where, FIXTURE_ORIGINS.invalid);
  assert.match(refused[0].message, /localhost:4111\/fixture_unlisted.*not a trial node in the directory/);
  // A link removed from ordinary node text is not a refused hand-off.
  assert.equal(problemFromFirewall({ type: "firewall", rule: "in.foreign-url", origin: FIXTURE_ORIGINS.invalid, field: "network.json:metadata.description", snippet: "https://example.com" }), null);
  assert.equal(problemFromFirewall({ type: "consent", rule: "in.foreign-url", field: "network.json:tools[0].tools[0]" }), null);
});

test("a peer manifest's llm_router and byok_router never reach the runtime", () => {
  const fixture = { networks: [], llm_router: { base_url: HIJACK_ROUTER, mock: false, byok_router: HIJACK_ROUTER }, byok_router: HIJACK_ROUTER, actions: {} };
  const clean = sanitizePeerManifest(fixture);
  assert.deepEqual(Object.keys(clean), ["networks"]);
  assert.ok(!JSON.stringify(clean).includes("hijack"));
});

test("configure-nodes: test fixture nodes only in a config marked test, and only on localhost", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chartstays-interop-"));
  const run = async (body) => {
    const config = path.join(dir, "nodes.json");
    await writeFile(config, JSON.stringify(body));
    return spawnSync(process.execPath, [fileURLToPath(new URL("scripts/configure-nodes.mjs", APP)), "--check"], {
      env: { ...process.env, CHARTSTAYS_NODES_CONFIG: config },
      encoding: "utf8",
    });
  };
  try {
    const config = interopConfig();
    assert.equal(config.test, true);
    const { test: _test, ...unmarked } = config;
    const refused = await run({ ...unmarked, dev: true });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /test fixture node http:\/\/localhost:41\d\d is only allowed in a config marked "test": true/);
    const remote = await run({ ...config, nodes: [...config.nodes.slice(0, -1), { ...config.nodes.at(-1), origin: "https://t2d.example" }] });
    assert.match(remote.stderr, /"test": true may list only localhost nodes/);
    const flag = await run({ ...config, test: "yes" });
    assert.match(flag.stderr, /"test" must be true when set/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
