// Fetch ClinicalTrials.gov snapshots.
//
//   node src/cli/fetch.ts                      fetch every study in data/curation/*.json
//   node src/cli/fetch.ts --area obesity       fetch one area's studies
//   node src/cli/fetch.ts --discover obesity [--page-size 40] [--out file.json]
//                                              list RECRUITING candidates (writes nothing in data/)
//
// Responses are untrusted data: they are parsed as JSON and stored, never executed.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { AREAS, findArea, type Area } from "../areas.ts";
import { CTGOV_API, SNAPSHOT_FIELDS, type CtgovStudy, type Snapshot } from "../ctgov.ts";
import { loadCuration } from "../curate.ts";
import { PATHS } from "../paths.ts";

const NCT = /^NCT\d{8}$/;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function apiVersion(): Promise<string | null> {
  const body = (await getJson(`${CTGOV_API}/version`)) as { apiVersion?: unknown };
  return typeof body.apiVersion === "string" ? body.apiVersion : null;
}

function studiesOf(body: unknown): CtgovStudy[] {
  const studies = (body as { studies?: unknown }).studies;
  if (!Array.isArray(studies)) throw new Error("ClinicalTrials.gov response has no studies array");
  return studies as CtgovStudy[];
}

async function discover(area: Area, pageSize: number, out: string | undefined): Promise<void> {
  const params = new URLSearchParams({
    "query.cond": area.query,
    "filter.overallStatus": "RECRUITING",
    "aggFilters": "studyType:int",
    pageSize: String(pageSize),
    fields: ["NCTId", "BriefTitle", "MinimumAge", "MaximumAge", "Sex", "Condition", "EligibilityCriteria", "LocationCountry"].join(","),
  });
  const studies = studiesOf(await getJson(`${CTGOV_API}/studies?${params}`));
  const rows = studies.map((s) => {
    const p = s.protocolSection;
    const text = p.eligibilityModule.eligibilityCriteria ?? "";
    return {
      nct_id: p.identificationModule.nctId,
      title: p.identificationModule.briefTitle,
      age: `${p.eligibilityModule.minimumAge ?? "-"}..${p.eligibilityModule.maximumAge ?? "-"}`,
      sex: p.eligibilityModule.sex ?? null,
      conditions: p.conditionsModule?.conditions ?? [],
      criteria_chars: text.length,
      mentions: ["HbA1c", "A1c", "eGFR", "BMI", "body mass", "metformin", "insulin"].filter((w) => text.toLowerCase().includes(w.toLowerCase())),
      countries: [...new Set((p.contactsLocationsModule?.locations ?? []).map((l) => l.country))].slice(0, 5),
      criteria: text,
    };
  });
  const json = `${JSON.stringify(rows, null, 2)}\n`;
  if (out) {
    await writeFile(out, json);
    console.log(`Wrote ${rows.length} candidates for ${area.slug} to ${out}`);
  } else {
    process.stdout.write(json);
  }
}

async function fetchArea(area: Area, version: string | null, retrieved: string): Promise<number> {
  const ids = (await loadCuration(area.slug)).studies.map((s) => s.nct_id);
  if (!ids.length) {
    console.warn(`${area.slug}: no studies listed in data/curation/${area.slug}.json, skipped`);
    return 0;
  }
  for (const id of ids) {
    if (!NCT.test(id)) throw new Error(`${area.slug}: invalid NCT id ${id}`);
  }
  const params = new URLSearchParams({
    "filter.ids": ids.join(","),
    pageSize: String(ids.length),
    fields: SNAPSHOT_FIELDS.join(","),
  });
  const url = `${CTGOV_API}/studies?${params}`;
  const studies = studiesOf(await getJson(url));
  const dir = path.join(PATHS.ctgov, area.slug);
  await mkdir(dir, { recursive: true });
  const found = new Set<string>();
  for (const study of studies) {
    const nctId = study.protocolSection.identificationModule.nctId;
    if (!NCT.test(nctId) || !ids.includes(nctId)) {
      throw new Error(`${area.slug}: unexpected study ${nctId} in response`);
    }
    found.add(nctId);
    const snapshot: Snapshot = { retrieved, api_version: version, request_url: url, study };
    await writeFile(path.join(dir, `${nctId}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`${area.slug}: ClinicalTrials.gov did not return ${missing.join(", ")}`);
  for (const study of studies) {
    const status = study.protocolSection.statusModule.overallStatus;
    if (status !== "RECRUITING") console.warn(`${area.slug}: ${study.protocolSection.identificationModule.nctId} is now ${status}`);
  }
  console.log(`${area.slug}: wrote ${studies.length} snapshots to ${path.relative(process.cwd(), dir)}`);
  return studies.length;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      area: { type: "string" },
      discover: { type: "string" },
      "page-size": { type: "string", default: "30" },
      out: { type: "string" },
    },
  });
  if (values.discover) {
    const pageSize = Number(values["page-size"]);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("--page-size must be 1..1000");
    await discover(findArea(values.discover), pageSize, values.out);
    return;
  }
  const areas = values.area ? [findArea(values.area)] : AREAS;
  const version = await apiVersion();
  const retrieved = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const area of areas) total += await fetchArea(area, version, retrieved);
  console.log(`Done: ${total} snapshots (API ${version ?? "unknown"}, retrieved ${retrieved}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
