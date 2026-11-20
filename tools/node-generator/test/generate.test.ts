import assert from "node:assert/strict";
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import { AREAS, type Area } from "../src/areas.ts";
import { logisticsFrom, studyFacts } from "../src/ctgov.ts";
import { loadCuration, loadSnapshot } from "../src/curate.ts";
import {
  agentManifest,
  DISCLAIMER,
  generateNode,
  networkHocon,
  renderPage,
  requiredFiles,
  runBuildNetwork,
  templateRule,
  WORKER_CSP,
  type NodeStudy,
} from "../src/generate.ts";
import { PATHS, REPO_ROOT } from "../src/paths.ts";

let outRoot = "";
const dirs = new Map<string, string>();

before(async () => {
  outRoot = await mkdtemp(path.join(os.tmpdir(), "chartstays-gen-"));
  for (const area of AREAS) dirs.set(area.slug, await generateNode(area, outRoot));
});

after(async () => {
  await rm(outRoot, { recursive: true, force: true });
});

function dirOf(area: Area): string {
  const dir = dirs.get(area.slug);
  if (dir === undefined) throw new Error(`${area.slug} was not generated`);
  return dir;
}

async function parseHocon(text: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(path.join(PATHS.vendorRuntime, "hocon.js")).href;
  const mod = (await import(url)) as { parseHocon: (source: string) => Record<string, unknown> };
  return mod.parseHocon(text);
}

for (const area of AREAS) {
  test(`${area.slug}: generator writes every required file`, async () => {
    const dir = dirOf(area);
    for (const file of requiredFiles(area)) {
      await access(path.join(dir, file));
    }
    const criteria = (await readdir(path.join(dir, "criteria"))).filter((f) => f.startsWith("NCT"));
    const logistics = await readdir(path.join(dir, "logistics"));
    assert.ok(criteria.length >= 1);
    assert.deepEqual(logistics.sort(), criteria.sort());
  });

  test(`${area.slug}: generated node passes build_network --check`, () => {
    const check = runBuildNetwork(dirOf(area), area, true);
    assert.equal(check.status, 0, check.output);
  });

  test(`${area.slug}: manifest front_man is the first agent with instructions`, async () => {
    const dir = dirOf(area);
    const manifest = JSON.parse(await readFile(path.join(dir, "agent-manifest.json"), "utf8"));
    const network = JSON.parse(await readFile(path.join(dir, `${area.network}.network.json`), "utf8"));
    const first = network.tools.find((t: { instructions?: string }) => typeof t.instructions === "string");
    assert.equal(manifest.networks[0].front_man, first.name);
    assert.match(first.instructions, /not medical advice/);
    assert.match(first.instructions, /\{grounding_rules\}/);
    // The runtime expands {grounding_rules} from commondefs.
    assert.match(network.commondefs.replacement_strings.grounding_rules, /Answer only about the studies published on this node/);
  });

  test(`${area.slug}: page shows attribution, retrieval date and the disclaimer`, async () => {
    const dir = dirOf(area);
    const html = await readFile(path.join(dir, "index.html"), "utf8");
    const index = JSON.parse(await readFile(path.join(dir, "criteria", "index.json"), "utf8"));
    assert.match(html, /ClinicalTrials\.gov/);
    assert.ok(html.includes(index.source.retrieved));
    assert.ok(html.includes("Demo node, not a real trial site; pre-screening only, not medical advice."));
    assert.equal(index.disclaimer, DISCLAIMER);
    // The page keeps its "Demo node" banner; what the app and its assistant read stays neutral.
    const manifest = JSON.parse(await readFile(path.join(dir, "agent-manifest.json"), "utf8"));
    assert.equal(manifest.brand, `ChartStays · ${area.title}`);
    for (const f of ["agent-manifest.json", `${area.network}.network.json`, "criteria/index.json"]) {
      assert.doesNotMatch(await readFile(path.join(dir, f), "utf8"), /demo node/i, f);
    }
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  });

  test(`${area.slug}: _headers allows any origin to read JSON and locks the sandbox worker`, async () => {
    const headers = await readFile(path.join(dirOf(area), "_headers"), "utf8");
    assert.match(headers, /^\/\*\n {2}Referrer-Policy: no-referrer$/m);
    assert.equal(headers.match(/Referrer-Policy/g)?.length, 1);
    assert.equal(headers.match(/^\/\*\.json$/gm)?.length, 1);
    assert.match(headers, /^\/\*\.json\n {2}Access-Control-Allow-Origin: \*/m);
    // Prefix rules also match *.json: they detach the header first, so Pages sends one "*", not "*, *".
    for (const prefix of ["/criteria/*", "/logistics/*", "/.well-known/*", "/bridge/*"]) {
      assert.ok(headers.includes(`${prefix}\n  ! Access-Control-Allow-Origin\n  Access-Control-Allow-Origin: *\n`), prefix);
    }
    assert.ok(
      headers.includes(`/runtime/sandbox-worker.js\n  Content-Security-Policy: default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'\n`),
      headers,
    );
  });
}

test("the worker CSP matches the local dev server", async () => {
  const server = await readFile(path.join(REPO_ROOT, "tools", "serve-nodes.mjs"), "utf8");
  assert.ok(server.includes(`const WORKER_CSP = "${WORKER_CSP}";`));
});

async function studyWith(area: Area, facts: { title?: string; nct_id?: string }): Promise<NodeStudy> {
  const { nct_id: nctId } = (await loadCuration(area.slug)).studies[0]!;
  const snapshot = await loadSnapshot(area.slug, nctId);
  const criteria = JSON.parse(await readFile(path.join(PATHS.curated, `${nctId}.criteria.json`), "utf8")) as CriteriaDocument;
  return { facts: { ...studyFacts(snapshot), ...facts }, criteria, logistics: logisticsFrom(snapshot), retrieved: snapshot.retrieved };
}

test("study titles and ids from ClinicalTrials.gov are escaped in index.html", async () => {
  const area = AREAS[0]!;
  const attack = `"><script>alert(1)</script>`;
  const html = await renderPage(area, [await studyWith(area, { title: attack, nct_id: `NCT"><img src=x onerror=alert(2)>` })], "2026-11-16");
  assert.ok(!html.includes(attack));
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("HOCON strings with quotes, braces and ${ stay literal", async () => {
  const base = AREAS[0]!;
  const nasty = `x" } "tools": [] ${"${"}HOME} """ \\ ${"${"}?evil}`;
  const area: Area = {
    ...base,
    title: `T2D ${nasty}`,
    description: `Desc ${nasty}`,
    sampleQueries: [`Query ${nasty}`, "plain"],
  };
  const hocon = networkHocon(area, await templateRule("peer_rules"), await templateRule("cruse_rules"));
  const live = hocon.split("\n").filter((line) => !/^\s*(#|\/\/)/.test(line));
  assert.ok(!live.some((line) => line.includes("${")), "a ${ substitution reached the HOCON");

  const parsed = await parseHocon(hocon);
  const metadata = parsed.metadata as { description: string; sample_queries: string[] };
  assert.equal(metadata.description, area.description);
  assert.deepEqual(metadata.sample_queries, area.sampleQueries);
  const tools = parsed.tools as { name: string; function: { description: string } }[];
  assert.deepEqual(tools.map((t) => t.name), ["trial_desk", "criteria_agent", "logistics_agent"]);
  assert.ok(tools[0]!.function.description.includes(nasty.toLowerCase()));
  const strings = (parsed.commondefs as { replacement_strings: { site_name: string } }).replacement_strings;
  assert.equal(strings.site_name, `ChartStays ${area.title}`);

  // The vendored validator accepts it and writes the same values to network.json.
  const dir = path.join(outRoot, "hocon-injection");
  await cp(dirOf(base), dir, { recursive: true });
  await writeFile(path.join(dir, `${area.network}.hocon`), hocon);
  await writeFile(path.join(dir, "agent-manifest.json"), `${JSON.stringify(agentManifest(area), null, 2)}\n`);
  const build = runBuildNetwork(dir, area, false);
  assert.equal(build.status, 0, build.output);
  const network = JSON.parse(await readFile(path.join(dir, `${area.network}.network.json`), "utf8"));
  assert.equal(network.metadata.description, area.description);
});
