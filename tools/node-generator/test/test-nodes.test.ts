import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../src/paths.ts";
import { testNodeLeaks } from "../src/test-nodes.ts";

const t2d = { origin: "http://localhost:4101", network: "t2d_trials" };

test("testNodeLeaks accepts the normal nodes", () => {
  assert.deepEqual(testNodeLeaks("x", { nodes: [t2d] }), []);
});

test("testNodeLeaks flags a node marked test, a fixture_ network, a fixture port and a test config", () => {
  assert.equal(testNodeLeaks("x", { nodes: [{ ...t2d, test: true }] }).length, 1);
  assert.equal(testNodeLeaks("x", { nodes: [{ origin: "https://n.example", network: "fixture_cycle" }] }).length, 1);
  assert.equal(testNodeLeaks("x", { nodes: [{ origin: "http://localhost:4106", network: "t2d_trials" }] }).length, 1);
  assert.equal(testNodeLeaks("x", { nodes: [{ origin: "http://localhost:4111", network: "t2d_trials" }] }).length, 1);
  assert.equal(testNodeLeaks("x", { nodes: [{ origin: "http://localhost:4105", network: "shady_demo_trials" }] }).length, 0);
  assert.equal(testNodeLeaks("x", { test: true, nodes: [t2d] }).length, 1);
});

test("the interop fixture config would fail validate, and its ports match test-nodes.ts", async () => {
  const fixtures = (await import(path.join(REPO_ROOT, "tools", "e2e", "interop-fixtures.mjs"))) as {
    interopConfig: () => { test?: unknown; nodes: { origin: string; network: string; test?: unknown }[] };
    FIXTURE_PORTS: Record<string, number>;
  };
  const config = fixtures.interopConfig();
  const leaks = testNodeLeaks("nodes.interop.json", config);
  // The config flag plus every fixture node; the real t2d node it also lists is not flagged.
  assert.equal(leaks.length, 1 + config.nodes.filter((n) => n.test === true).length);
  for (const port of Object.values(fixtures.FIXTURE_PORTS)) {
    assert.equal(testNodeLeaks("x", { nodes: [{ origin: `http://localhost:${port}`, network: "n" }] }).length, 1, `port ${port}`);
  }
});

test("the default config and directory list no test fixture node", async () => {
  for (const file of ["config/nodes.dev.json", "public/directory.json"]) {
    const config = JSON.parse(await readFile(path.join(REPO_ROOT, "apps", "patient", file), "utf8")) as { nodes: { origin: string; network: string }[] };
    assert.deepEqual(testNodeLeaks(file, config), []);
  }
});
