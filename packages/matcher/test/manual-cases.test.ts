// Hand-checked patient x study cases. The expected tier and reasons below were derived by
// reading the curated criteria (data/curated/<NCT>.criteria.json) and the raw date-shifted
// Synthea bundle (data/synthea/shifted/<patient>.json) directly, not copied from matcher
// output. Evaluation date 2026-11-16, labs older than 365 days count as unknown.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import { parseBundle } from "@chartstays/fhir-profile";
import { evaluateStudy } from "../src/index.ts";

const AS_OF = new Date("2026-11-16T00:00:00Z");
const DATA = new URL("../../../data/", import.meta.url);
const SHIFTED = new URL("synthea/shifted/", DATA);

function study(nct: string): CriteriaDocument {
  return JSON.parse(readFileSync(new URL(`curated/${nct}.criteria.json`, DATA), "utf8")) as CriteriaDocument;
}

function evaluate(patient: string, nct: string) {
  const file = readdirSync(SHIFTED).find((f) => f.startsWith(`${patient}_`));
  assert.ok(file, `${patient} bundle`);
  const profile = parseBundle(JSON.parse(readFileSync(new URL(file, SHIFTED), "utf8")), { asOf: AS_OF });
  const r = evaluateStudy(profile, study(nct));
  return { r, status: Object.fromEntries(r.criteria.filter((c) => c.kind !== "free_text").map((c) => [c.id, c.status])) };
}

test("Angelyn934 x NCT07272343 (type 2 diabetes): strong_match with 9 items to confirm", () => {
  // Criteria: inc-0a age 18-75; inc-2 BMI >= 25 kg/m2; inc-3 type 2 diabetes (SNOMED 44054006,
  // primary); inc-4 HbA1c <= 8.5 %; exc-1 BMI < 25 kg/m2; 9 free-text lines.
  // Record: female, born 1965-11-28 -> 60 on 2026-11-16 (birthday not yet reached): inc-0a met.
  // Condition 44054006 "Diabetes mellitus type 2", clinicalStatus active, verification confirmed: inc-3 met.
  // Latest BMI (39156-5) 30.45 kg/m2 on 2026-11-01: inc-2 met (>= 25), exc-1 not met (not < 25).
  // Latest HbA1c (4548-4) 3.11 % on 2026-11-01: inc-4 met (<= 8.5).
  // No coded criterion unknown, nothing blocks -> strong_match; the 9 free-text lines are the items to confirm.
  const { r, status } = evaluate("Angelyn934", "NCT07272343");
  assert.equal(r.verdict, "strong_match");
  assert.deepEqual(status, { "inc-0a": "met", "inc-2": "met", "inc-3": "met", "inc-4": "met", "exc-1": "not_met" });
  assert.deepEqual(r.unknowns, { structured: 0, free_text: 9 });
  assert.deepEqual(r.reasons, ["Every coded inclusion criterion is met and no coded exclusion applies.", "9 items to confirm with your doctor."]);
});

test("Noriko180 x NCT07776613 (breast cancer): possible_match, osteoporosis not recorded", () => {
  // Criteria: inc-0a age >= 18; inc-0b female; inc-2a breast cancer (254837009, primary);
  // inc-4a osteoporosis or history of osteoporotic fracture (64859006, 443165006, not primary).
  // Record: female, born 1978-07-02 -> 48: inc-0a and inc-0b met.
  // Condition 254837009 "Malignant neoplasm of breast", active, onset 2026-07-16: inc-2a met.
  // Neither 64859006 nor 443165006 appears in the record. inc-4a is a supporting (non-primary)
  // inclusion, so absence is unknown, not a blocker -> possible_match.
  const { r, status } = evaluate("Noriko180", "NCT07776613");
  assert.equal(r.verdict, "possible_match");
  assert.deepEqual(status, { "inc-0a": "met", "inc-0b": "met", "inc-2a": "met", "inc-4a": "unknown" });
  assert.equal(r.reasons[0], "Unknown inclusion: Osteoporosis or history of osteoporotic fracture is not recorded; the imported record may be incomplete.");
  assert.equal(r.reasons[1], "9 items to confirm with your doctor.");
});

test("Brett333 x NCT07564414 (obesity): not_eligible, BMI below 35", () => {
  // Criteria: inc-0a age >= 18; inc-3 BMI >= 35 kg/m2 (39156-5).
  // Record: male, born 2001-08-05 -> 25: inc-0a met. Latest BMI 27.78 kg/m2 on 2026-10-18
  // (29 days before asOf, fresh): 27.78 < 35 -> inc-3 not met -> not_eligible.
  const { r, status } = evaluate("Brett333", "NCT07564414");
  assert.equal(r.verdict, "not_eligible");
  assert.deepEqual(status, { "inc-0a": "met", "inc-3": "not_met" });
  assert.deepEqual(r.reasons, ["Inclusion not met: Latest Body mass index (BMI) [Ratio] is 27.78 kg/m2 on 2026-10-18, not at least 35 kg/m2."]);
});

test("Marlin805 x NCT06858449 (breast cancer): not_eligible, male and no breast cancer", () => {
  // Criteria: inc-0a age 20-89; inc-0b female; inc-2a breast cancer (254837009, primary).
  // Record: male, born 1966-07-10 -> 60: inc-0a met; inc-0b not met (male).
  // No Condition with 254837009; the condition is primary, so absence is not met.
  // Two blocking inclusions -> not_eligible, both listed.
  const { r, status } = evaluate("Marlin805", "NCT06858449");
  assert.equal(r.verdict, "not_eligible");
  assert.deepEqual(status, { "inc-0a": "met", "inc-0b": "not_met", "inc-2a": "not_met" });
  assert.deepEqual(r.reasons, ["Inclusion not met: Sex is male; the criterion requires female.", "Inclusion not met: No matching condition in the record (Breast cancer)."]);
});
