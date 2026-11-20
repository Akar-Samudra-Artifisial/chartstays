// pnpm validate: exit non-zero when any check fails.
//   1. Each node in dist/nodes passes the vendored build_network.mjs --check.
//   2. Each node has the required files, and its criteria/*.json match the schema.
//   3. Every data/curated/*.criteria.json matches the schema, has a non-age structured
//      criterion, and uses only codes found in the Synthea sample (code-inventory.json).
//   4. Every data/curated/*.criteria.json equals a fresh curate(snapshot, map) (no stale curation).
//   5. The patient app's network passes build_network.mjs --check, its generated node files
//      (directory.json, HOCON, allowed_peers) are up to date, and the directory matches the areas.
//   6. The default node config and public/directory.json list no DEMO / ADVERSARIAL node and no
//      TEST-ONLY interop fixture node (src/test-nodes.ts), and dist/nodes (the deployable nodes)
//      does not contain the demo node.
// The shady demo node (dist/demo-nodes/shady-demo) gets checks 1 and 2 only: it is spec-valid by
// design, and is not an area (no curation, not in the default directory).

import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hasNonAgeStructured, validateCriteria, type CriteriaDocument } from "@chartstays/criteria-schema";
import { AREAS, type Area } from "../areas.ts";
import { curate, loadCuration, loadSnapshot, matchesCuration } from "../curate.ts";
import { requiredFiles, runBuildNetwork } from "../generate.ts";
import { PATHS, REPO_ROOT } from "../paths.ts";
import { SHADY_AREA } from "../shady.ts";
import { testNodeLeaks } from "../test-nodes.ts";

interface InventoryCode { resource: string; code: string }

const MIN_CURATED = 16;

async function inventory(): Promise<Map<string, Set<string>>> {
  const data = JSON.parse(await readFile(PATHS.syntheaInventory, "utf8")) as { codes: InventoryCode[] };
  const byResource = new Map<string, Set<string>>();
  for (const { resource, code } of data.codes) {
    if (!byResource.has(resource)) byResource.set(resource, new Set());
    byResource.get(resource)!.add(code);
  }
  return byResource;
}

function unknownCodes(doc: CriteriaDocument, codes: Map<string, Set<string>>): string[] {
  const has = (resource: string, code: string): boolean => codes.get(resource)?.has(code) ?? false;
  const problems: string[] = [];
  for (const c of doc.structured) {
    if (c.kind === "condition") {
      for (const code of c.codes.snomed) if (!has("Condition", code)) problems.push(`${c.id}: SNOMED ${code}`);
    } else if (c.kind === "lab") {
      if (!has("Observation", c.loinc)) problems.push(`${c.id}: LOINC ${c.loinc}`);
    } else if (c.kind === "medication") {
      for (const code of c.rxnorm) if (!has("MedicationRequest", code)) problems.push(`${c.id}: RxNorm ${code}`);
    }
  }
  return problems;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

const PATIENT_APP = path.join(REPO_ROOT, "apps", "patient");

function run(args: string[], cwd: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Check 5: the patient app network and its trial node directory. Returns failures. */
async function checkPatientApp(): Promise<string[]> {
  const failures: string[] = [];
  const configure = run([path.join(PATIENT_APP, "scripts", "configure-nodes.mjs"), "--check"], PATIENT_APP);
  if (configure.status !== 0) failures.push(`apps/patient: ${configure.output.trim()}`);
  const network = run(
    [
      PATHS.buildNetwork,
      "agent/patient_navigator.hocon",
      "--manifest", "public/agent-manifest.json",
      "--runtime", PATHS.vendorRuntime,
      "--out", "public/patient_navigator.network.json",
      "--check",
    ],
    PATIENT_APP,
  );
  if (network.status !== 0) {
    failures.push(`apps/patient: build_network --check failed:\n${network.output}`);
  } else {
    const warnings = network.output.split("\n").filter((l) => l.startsWith("WARNING:"));
    console.log(`apps/patient: build_network --check OK${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  const directory = (await readJson(path.join(PATIENT_APP, "public", "directory.json"))) as { nodes: { origin: string; area: string; network: string }[] };
  const manifest = (await readJson(path.join(PATIENT_APP, "public", "agent-manifest.json"))) as { allowed_peers?: string[] };
  const origins = directory.nodes.map((n) => n.origin).sort();
  const peers = [...(manifest.allowed_peers ?? [])].sort();
  if (JSON.stringify(origins) !== JSON.stringify(peers)) failures.push(`apps/patient: allowed_peers ${peers.join(", ")} differ from directory.json origins ${origins.join(", ")}`);
  for (const node of directory.nodes) {
    const area = AREAS.find((a) => a.slug === node.area);
    if (area === undefined) failures.push(`apps/patient: directory.json area ${node.area} is not a known area`);
    else if (area.network !== node.network) failures.push(`apps/patient: directory.json ${node.area} names network ${node.network}, the node publishes ${area.network}`);
  }
  console.log(`apps/patient: ${directory.nodes.length} directory nodes checked against allowed_peers and the areas`);
  return failures;
}

/** Checks 1 and 2 for one generated node. Returns failures. */
async function checkNode(area: Area, label = ""): Promise<string[]> {
  const failures: string[] = [];
  const dir = path.join(area.slug === SHADY_AREA.slug ? PATHS.distDemoNodes : PATHS.distNodes, area.slug);
  const missing: string[] = [];
  for (const file of requiredFiles(area)) {
    try {
      await access(path.join(dir, file));
    } catch {
      missing.push(file);
    }
  }
  if (missing.length) return [`${area.slug}: missing ${missing.join(", ")} (run pnpm gen)`];
  const check = runBuildNetwork(dir, area, true);
  if (check.status !== 0) {
    failures.push(`${area.slug}: build_network --check failed:\n${check.output}`);
  } else {
    const warnings = check.output.split("\n").filter((l) => l.startsWith("WARNING:"));
    console.log(`${area.slug}${label}: build_network --check OK${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  const criteriaDir = path.join(dir, "criteria");
  const files = (await readdir(criteriaDir)).filter((f) => /^NCT\d{8}\.json$/.test(f));
  for (const file of files) {
    const result = validateCriteria(await readJson(path.join(criteriaDir, file)));
    if (!result.valid) failures.push(`${area.slug}/criteria/${file}: ${result.errors.join("; ")}`);
  }
  console.log(`${area.slug}${label}: ${files.length} criteria files checked against the schema`);
  return failures;
}

/**
 * Check 6: the default build never loads the DEMO / ADVERSARIAL node. Neither the default node
 * config nor the generated public/directory.json may list it or any node marked demo.
 */
async function checkNoDemoInDefault(): Promise<string[]> {
  const failures: string[] = [];
  const shadyOrigin = `http://localhost:${SHADY_AREA.port}`;
  const sources: [string, string][] = [
    ["config/nodes.dev.json", path.join(PATIENT_APP, "config", "nodes.dev.json")],
    ["config/nodes.prod.example.json", path.join(PATIENT_APP, "config", "nodes.prod.example.json")],
    ["public/directory.json", path.join(PATIENT_APP, "public", "directory.json")],
  ];
  for (const [name, file] of sources) {
    const config = (await readJson(file)) as { test?: unknown; nodes: { origin: string; area: string; network: string; demo?: unknown; test?: unknown }[] };
    const { nodes } = config;
    // The TEST-ONLY interop fixtures (tools/e2e/interop-fixtures.mjs) may never be listed either.
    failures.push(...testNodeLeaks(`apps/patient/${name}`, config));
    for (const node of nodes) {
      if (node.demo !== undefined || node.area === SHADY_AREA.slug || node.network === SHADY_AREA.network || node.origin === shadyOrigin) {
        failures.push(`apps/patient/${name}: lists the demo node ${node.origin}; it belongs only in config/nodes.demo.json`);
      }
    }
  }
  // dist/nodes is what gets deployed: the demo node lives in dist/demo-nodes only.
  const deployable = await readdir(PATHS.distNodes);
  if (deployable.includes(SHADY_AREA.slug)) failures.push(`dist/nodes/${SHADY_AREA.slug}: the demo node must not be in dist/nodes (run pnpm gen; it writes dist/demo-nodes)`);
  console.log("apps/patient: default node config and directory.json list no demo node; dist/nodes has no demo node");
  return failures;
}

async function main(): Promise<void> {
  const failures: string[] = [];

  for (const area of AREAS) failures.push(...(await checkNode(area)));
  // The DEMO / ADVERSARIAL node is checked like the others (it is spec-valid on purpose: its
  // attacks are in the content, which only the patient app's Agent Firewall judges), but it is
  // not an area: it has no curation and must never be in the default directory (check 6).
  failures.push(...(await checkNode(SHADY_AREA, " (DEMO / ADVERSARIAL)")));

  const codes = await inventory();
  const curatedFiles = (await readdir(PATHS.curated)).filter((f) => f.endsWith(".criteria.json"));
  let withNonAge = 0;
  for (const file of curatedFiles) {
    const doc = await readJson(path.join(PATHS.curated, file));
    const result = validateCriteria(doc);
    if (!result.valid) {
      failures.push(`data/curated/${file}: ${result.errors.join("; ")}`);
      continue;
    }
    const criteria = doc as CriteriaDocument;
    if (hasNonAgeStructured(criteria)) withNonAge += 1;
    else failures.push(`data/curated/${file}: no structured criterion besides age`);
    const unknown = unknownCodes(criteria, codes);
    if (unknown.length) failures.push(`data/curated/${file}: codes not in the Synthea sample: ${unknown.join(", ")}`);
  }
  console.log(`data/curated: ${curatedFiles.length} files, ${withNonAge} with a non-age structured criterion`);

  const expected = new Set<string>();
  for (const area of AREAS) {
    const curation = await loadCuration(area.slug);
    for (const study of curation.studies) {
      const file = `${study.nct_id}.criteria.json`;
      expected.add(file);
      if (!curatedFiles.includes(file)) {
        failures.push(`data/curated/${file}: missing (run node tools/node-generator/src/cli/curate.ts)`);
        continue;
      }
      const fresh = curate(await loadSnapshot(area.slug, study.nct_id), study);
      if (!matchesCuration(await readJson(path.join(PATHS.curated, file)), fresh)) {
        failures.push(`data/curated/${file}: stale; differs from curate(snapshot, data/curation/${area.slug}.json) (rerun curate)`);
      }
    }
  }
  for (const file of curatedFiles) {
    if (!expected.has(file)) failures.push(`data/curated/${file}: not listed in any data/curation/*.json`);
  }
  console.log(`data/curated: ${expected.size} files compared with a fresh curate() run`);
  failures.push(...(await checkPatientApp()));
  failures.push(...(await checkNoDemoInDefault()));
  if (withNonAge < MIN_CURATED) failures.push(`only ${withNonAge} curated studies with a non-age structured criterion; need ${MIN_CURATED}`);

  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(`Validation failed: ${failures.length} problem(s).`);
    process.exitCode = 1;
    return;
  }
  console.log("Validation passed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
