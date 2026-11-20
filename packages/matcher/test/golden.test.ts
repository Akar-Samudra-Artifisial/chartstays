// Golden matrix: every date-shifted Synthea subset patient x every curated study, compared with the
// committed snapshot in test/__golden__/matrix.json. A change in the parser, the matcher
// or the data shows up as a diff here. Refresh after a reviewed change with:
//   UPDATE_GOLDEN=1 pnpm --filter @chartstays/matcher test

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import { parseBundle } from "@chartstays/fhir-profile";
import { evaluateStudy } from "../src/index.ts";

// Same evaluation date as `pnpm match:report`: the ClinicalTrials.gov retrieval date.
const AS_OF = new Date("2026-11-16T00:00:00Z");
const DATA = new URL("../../../data/", import.meta.url);
const GOLDEN = new URL("./__golden__/matrix.json", import.meta.url);

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function matrix(): Record<string, Record<string, unknown>> {
  const curated = new URL("curated/", DATA);
  const docs = readdirSync(curated)
    .filter((f) => f.endsWith(".criteria.json"))
    .sort()
    .map((f) => readJson<CriteriaDocument>(new URL(f, curated)));
  // Date-shifted copies (pnpm synthea:timeshift), as used by the report and the demo.
  const patients = new URL("synthea/shifted/", DATA);
  const out: Record<string, Record<string, unknown>> = {};
  for (const file of readdirSync(patients).filter((f) => f.endsWith(".json") && f !== "index.json").sort()) {
    const profile = parseBundle(readJson<unknown>(new URL(file, patients)), { asOf: AS_OF });
    const row: Record<string, unknown> = {};
    for (const doc of docs) {
      const r = evaluateStudy(profile, doc);
      row[doc.nct_id] = {
        verdict: r.verdict,
        counts: r.counts,
        unknowns: r.unknowns,
        structured: Object.fromEntries(r.criteria.filter((c) => c.kind !== "free_text").map((c) => [c.id, c.status])),
        reasons: r.reasons,
      };
    }
    out[file.replace(/\.json$/, "")] = row;
  }
  return out;
}

test("patient x study matrix equals the committed golden snapshot", () => {
  const actual = { asOf: AS_OF.toISOString().slice(0, 10), matrix: matrix() };
  if (process.env["UPDATE_GOLDEN"] === "1") {
    mkdirSync(new URL("./__golden__/", import.meta.url), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
  }
  assert.deepEqual(actual, readJson<unknown>(GOLDEN));
});
