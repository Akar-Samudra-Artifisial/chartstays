import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { assetsDir, pageTemplate, pageTokens, staticAssets } from "../index.js";

test("page.html contains every token the generator fills", async () => {
  const page = await readFile(path.join(assetsDir, pageTemplate), "utf8");
  for (const token of pageTokens) {
    assert.ok(page.includes(`{{${token}}}`), `missing {{${token}}}`);
  }
  assert.match(page, /Demo node, not a real trial site/);
  assert.match(page, /not medical advice/);
  assert.match(page, /ClinicalTrials\.gov/);
});

test("site actions register only read actions", async () => {
  const { registerActions } = await import(path.join(assetsDir, "site-actions.js"));
  const registered = [];
  registerActions({ register: (definition) => registered.push(definition) });
  assert.deepEqual(registered.map((a) => a.name), ["list_trials", "get_trial_criteria", "get_trial_logistics"]);
  for (const action of registered) {
    assert.equal(action.effect, "read");
    assert.equal(typeof action.execute, "function");
  }
});

test("study file reader rejects ids that are not NCT ids", async () => {
  const { registerActions } = await import(path.join(assetsDir, "site-actions.js"));
  const registered = [];
  registerActions({ register: (definition) => registered.push(definition) });
  const criteria = registered.find((a) => a.name === "get_trial_criteria");
  const result = await criteria.execute({ nct_id: "../secrets" });
  assert.equal(result.ok, false);
  assert.equal(result.field, "nct_id");
});

test("static assets exist", async () => {
  for (const asset of staticAssets) {
    await readFile(path.join(assetsDir, asset), "utf8");
  }
});
