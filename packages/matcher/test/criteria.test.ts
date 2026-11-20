import assert from "node:assert/strict";
import { test } from "node:test";
import type { PatientProfile } from "@chartstays/fhir-profile";
import { ABSENT_EXCLUSION, combineGroup, convert, evaluateStudy, includesHistory, rankStudies, toConfirmText, type CriterionStatus, type MatchOptions } from "../src/index.ts";
import { SNOMED, crit, doc, profile } from "./helpers.ts";

type Input = Parameters<typeof crit>[0];

function statusOf(c: Input, p: PatientProfile = profile(), opts: MatchOptions = {}): { status: CriterionStatus; reason: string } {
  const r = evaluateStudy(p, doc([crit(c)]), opts).criteria[0]!;
  return { status: r.status, reason: r.reason };
}

function check(cases: [string, Input, CriterionStatus, PatientProfile?, MatchOptions?][]): void {
  for (const [name, c, expected, p, opts] of cases) {
    const { status, reason } = statusOf(c, p, opts);
    assert.equal(status, expected, `${name}: ${reason}`);
    assert.match(reason, /^[A-Z0-9].*\.$/, `${name}: reason is one sentence`);
  }
}

const inc = "inclusion" as const;

test("age: inclusive limits, open ends, unknown age", () => {
  const age = (min: number | null, max: number | null): Input => ({ type: inc, kind: "age", min, max, unit: "years" });
  check([
    ["min equal", age(55, null), "met"],
    ["min above", age(56, null), "not_met"],
    ["max equal", age(null, 55), "met"],
    ["max below", age(18, 54), "not_met"],
    ["range", age(18, 75), "met"],
    ["no age", age(18, null), "unknown", profile({ age: null })],
  ]);
});

test("sex: match, mismatch, not recorded", () => {
  check([
    ["female", { type: inc, kind: "sex", sex: "female" }, "met"],
    ["male", { type: inc, kind: "sex", sex: "male" }, "not_met"],
    ["unknown", { type: inc, kind: "sex", sex: "female" }, "unknown", profile({ sex: "unknown" })],
    ["other", { type: inc, kind: "sex", sex: "female" }, "unknown", profile({ sex: "other" })],
  ]);
});

test("condition: active by default, history only when the label says so", () => {
  const cond = (codes: string[], label = "Condition", source_text = ""): Input => ({ type: inc, kind: "condition", primary: true, codes: { snomed: codes }, source_text, label });
  check([
    ["active", cond(["44054006"]), "met"],
    ["one of several codes", cond(["1", "44054006"]), "met"],
    ["resolved, current required", cond(["254837009"], "Breast cancer"), "not_met"],
    ["resolved, history of", cond(["254837009"], "Presence or history of malignant neoplasms"), "met"],
    ["resolved, prior", cond(["254837009"], "Prior breast cancer"), "met"],
    ["other system ignored", cond(["44054006"]), "not_met", profile({ conditions: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "44054006", display: "x", onset: null, abatement: null, active: true }] })],
  ]);
});

test("condition: history wording in source_text is ignored, negated history is not history", () => {
  const cond = (label: string, source_text = ""): Input => ({ type: inc, kind: "condition", primary: true, codes: { snomed: ["254837009"] }, source_text, label });
  check([
    ["history only in source text", cond("Breast cancer", "Breast cancer; no history of prior chemotherapy"), "not_met"],
    ["no prior", cond("No prior breast cancer"), "not_met"],
    ["without previous", cond("Breast cancer without previous treatment"), "not_met"],
    ["never", cond("Never had a history of breast cancer"), "not_met"],
    ["not any prior", cond("Not any prior breast cancer"), "not_met"],
  ]);
  assert.equal(includesHistory("No prior breast cancer"), false);
  assert.equal(includesHistory("History of breast cancer"), true);
  assert.equal(includesHistory("Previously treated breast cancer"), true);
});

test("condition: the condition with the most recent onset is reported", () => {
  const conditions = [
    { system: SNOMED, code: "44054006", display: "Older episode", onset: "2001-01-01", abatement: null, active: true },
    { system: SNOMED, code: "44054006", display: "No onset", onset: null, abatement: null, active: true },
    { system: SNOMED, code: "44054006", display: "Newest episode", onset: "2020-05-01", abatement: null, active: true },
  ];
  const r = statusOf({ type: inc, kind: "condition", codes: { snomed: ["44054006"] } }, profile({ conditions }));
  assert.equal(r.reason, "Active condition: Newest episode since 2020-05-01.");
  const provisional = [{ system: SNOMED, code: "44054006", display: "Diabetes", onset: "2020-01-01", abatement: null, active: false, unconfirmed: true as const }];
  const u = statusOf({ type: "exclusion", kind: "condition", codes: { snomed: ["44054006"] }, label: "History of diabetes" }, profile({ conditions: provisional }));
  assert.deepEqual(u, { status: "unknown", reason: "Diabetes is recorded as unconfirmed or provisional; the study team has to check it." });
});

test("absence: primary inclusion not met, other inclusions unknown, exclusions not met but unconfirmed", () => {
  const absent = (type: "inclusion" | "exclusion", kind: "condition" | "medication", primary = false): Input =>
    kind === "condition"
      ? { type, kind, codes: { snomed: ["64859006"] }, label: "Osteoporosis", ...(primary ? { primary: true as const } : {}) }
      : { type, kind, rxnorm: ["106892"], label: "Insulin" };
  const cases: [string, Input, CriterionStatus, RegExp][] = [
    ["primary inclusion condition", absent(inc, "condition", true), "not_met", /^No matching condition in the record \(Osteoporosis\)\.$/],
    ["non-primary inclusion condition", absent(inc, "condition"), "unknown", /not recorded; the imported record may be incomplete/],
    ["inclusion medication", absent(inc, "medication"), "unknown", /No active prescription matching insulin.*may be incomplete/],
    ["exclusion condition", absent("exclusion", "condition"), "not_met", /^No recorded exclusion applies \(based on the imported record; absence is not confirmed\)\.$/],
    ["exclusion medication", absent("exclusion", "medication"), "not_met", /^No recorded exclusion applies/],
  ];
  for (const [name, c, expected, reason] of cases) {
    const r = statusOf(c);
    assert.equal(r.status, expected, name);
    assert.match(r.reason, reason, name);
  }
  assert.equal(ABSENT_EXCLUSION, "No recorded exclusion applies (based on the imported record; absence is not confirmed).");
});

test("lab: every operator at its boundary", () => {
  const lab = (op: "lt" | "lte" | "gt" | "gte", value: number): Input => ({ type: inc, kind: "lab", loinc: "4548-4", op, value, unit: "%" });
  const between = (low: number, high: number): Input => ({ type: inc, kind: "lab", loinc: "4548-4", op: "between", value: [low, high], unit: "%" });
  check([
    ["gte equal", lab("gte", 7.5), "met"],
    ["gt equal", lab("gt", 7.5), "not_met"],
    ["gt below", lab("gt", 7.4), "met"],
    ["lte equal", lab("lte", 7.5), "met"],
    ["lt equal", lab("lt", 7.5), "not_met"],
    ["lt above", lab("lt", 7.6), "met"],
    ["between low edge", between(7.5, 10), "met"],
    ["between high edge", between(7, 7.5), "met"],
    ["between outside", between(7.6, 10), "not_met"],
  ]);
});

test("lab: unit conversion, unknown and incompatible units, non-numeric, missing", () => {
  check([
    ["g/L -> g/dL equal", { type: inc, kind: "lab", loinc: "718-7", op: "gte", value: 10, unit: "g/dL" }, "met"],
    ["g/L -> g/dL below", { type: inc, kind: "lab", loinc: "718-7", op: "gt", value: 10, unit: "g/dL" }, "not_met"],
    ["mg/mmol -> mg/g", { type: inc, kind: "lab", loinc: "14959-1", op: "gt", value: 265, unit: "mg/g" }, "met"],
    ["alias 1.73m2", { type: inc, kind: "lab", loinc: "33914-3", op: "gte", value: 45, unit: "mL/min/1.73m2" }, "met"],
    ["unknown observation unit", { type: inc, kind: "lab", loinc: "29463-7", op: "gte", value: 45, unit: "kg" }, "unknown"],
    ["unknown criterion unit", { type: inc, kind: "lab", loinc: "4548-4", op: "gte", value: 7, unit: "mmol/mol" }, "unknown"],
    ["mEq/L is not converted", { type: inc, kind: "lab", loinc: "2823-3", op: "gt", value: 4.9, unit: "mmol/L" }, "unknown"],
    ["incompatible", { type: inc, kind: "lab", loinc: "33914-3", op: "gte", value: 45, unit: "mL/min" }, "unknown"],
    ["coded value", { type: inc, kind: "lab", loinc: "72166-2", op: "gte", value: 1, unit: "%" }, "unknown"],
    ["missing", { type: inc, kind: "lab", loinc: "777-3", op: "gt", value: 75, unit: "10*3/uL" }, "unknown"],
  ]);
  const mismatch = statusOf({ type: inc, kind: "lab", loinc: "33914-3", op: "gte", value: 45, unit: "mL/min" });
  assert.match(mismatch.reason, /cannot be converted/);
  assert.deepEqual(convert(100, "g/L", "g/dL"), { ok: true, value: 10, converted: true });
  assert.deepEqual(convert(1, "mg/dL", "g/L"), { ok: true, value: 0.01, converted: true });
  assert.deepEqual(convert(1, "furlong", "kg"), { ok: false, reason: "unknown_unit", unit: "furlong" });
});

test("lab: results older than labMaxAgeDays are unknown (365 days still counts)", () => {
  check([
    ["exactly 365 days", { type: inc, kind: "lab", loinc: "39156-5", op: "gte", value: 30, unit: "kg/m2" }, "met"],
    ["366 days", { type: inc, kind: "lab", loinc: "2571-8", op: "lt", value: 500, unit: "mg/dL" }, "unknown"],
    ["custom window", { type: inc, kind: "lab", loinc: "4548-4", op: "gte", value: 7, unit: "%" }, "unknown", profile(), { labMaxAgeDays: 30 }],
    ["custom window, wide", { type: inc, kind: "lab", loinc: "2571-8", op: "lt", value: 500, unit: "mg/dL" }, "met", profile(), { labMaxAgeDays: 400 }],
  ]);
  assert.match(statusOf({ type: inc, kind: "lab", loinc: "2571-8", op: "lt", value: 500, unit: "mg/dL" }).reason, /older than 365 days/);
  assert.throws(() => evaluateStudy(profile(), doc([]), { labMaxAgeDays: -1 }), RangeError);
});

test("medication: active prescription met, otherwise unknown for inclusions", () => {
  check([
    ["active metformin", { type: inc, kind: "medication", rxnorm: ["860975"] }, "met"],
    ["insulin absent", { type: inc, kind: "medication", rxnorm: ["106892"] }, "unknown"],
    ["no medications", { type: inc, kind: "medication", rxnorm: ["860975"] }, "unknown", profile({ medications: [] })],
  ]);
});

test("free text is always unknown and does not lower the tier", () => {
  const r = evaluateStudy(profile(), doc([], [{ id: "inc-9", type: "inclusion", text: "Able to give consent" }]));
  assert.equal(r.criteria[0]!.status, "unknown");
  assert.equal(r.criteria[0]!.kind, "free_text");
  assert.equal(r.verdict, "strong_match");
  assert.deepEqual(r.unknowns, { structured: 0, free_text: 1 });
  assert.deepEqual(r.reasons, ["Every coded inclusion criterion is met and no coded exclusion applies.", "1 item to confirm with your doctor."]);
  assert.equal(toConfirmText(3), "3 items to confirm with your doctor.");
});

test("group logic: any / all truth table", () => {
  const table: ["any" | "all", CriterionStatus[], CriterionStatus][] = [
    ["any", ["met", "not_met"], "met"],
    ["any", ["met", "unknown"], "met"],
    ["any", ["not_met", "unknown"], "unknown"],
    ["any", ["not_met", "not_met"], "not_met"],
    ["all", ["met", "met"], "met"],
    ["all", ["met", "unknown"], "unknown"],
    ["all", ["not_met", "unknown"], "not_met"],
    ["all", ["met", "not_met"], "not_met"],
  ];
  for (const [logic, statuses, expected] of table) assert.equal(combineGroup(logic, statuses), expected, `${logic} ${statuses.join(",")}`);
});

test("groups in a study: exclusion 'any' with one met member excludes; unknown member alone gives review", () => {
  const potassium = (loinc: string): Input => ({ type: "exclusion", kind: "lab", loinc, op: "gt", value: 4.9, unit: "mmol/L", group: "exc-20", group_logic: "any" });
  // 2823-3 is in mEq/L (unknown), 6298-4 is 5.2 mmol/L (met): the group is met, the study excluded.
  const excluded = evaluateStudy(profile(), doc([crit(potassium("2823-3")), crit(potassium("6298-4"))]));
  assert.deepEqual(excluded.groups.map((g) => [g.group, g.status]), [["exc-20", "met"]]);
  assert.equal(excluded.verdict, "not_eligible");
  // Without the blood value only the unknown member is left: needs review.
  const p = profile();
  const { ["6298-4"]: _drop, ...rest } = p.observations;
  const review = evaluateStudy({ ...p, observations: rest }, doc([crit(potassium("2823-3")), crit(potassium("6298-4"))]));
  assert.equal(review.groups[0]!.status, "unknown");
  assert.equal(review.verdict, "possible_match");
  // Inclusion "all" group with one failing member fails the study.
  const all = (op: "gte" | "lt", value: number): Input => ({ type: inc, kind: "lab", loinc: "4548-4", op, value, unit: "%", group: "inc-4", group_logic: "all" });
  assert.equal(evaluateStudy(profile(), doc([crit(all("gte", 7)), crit(all("lt", 7.5))])).verdict, "not_eligible");
  assert.equal(evaluateStudy(profile(), doc([crit(all("gte", 7)), crit(all("lt", 8))])).verdict, "strong_match");
});

test("verdicts", () => {
  const t2d: Input = { type: inc, kind: "condition", codes: { snomed: ["44054006"] } };
  const insulin: Input = { type: "exclusion", kind: "medication", rxnorm: ["106892"] };
  const metformin: Input = { type: "exclusion", kind: "medication", rxnorm: ["860975"] };
  const unknownExclusion: Input = { type: "exclusion", kind: "lab", loinc: "777-3", op: "lt", value: 100, unit: "10*3/uL" };
  const osteoporosis: Input = { type: inc, kind: "condition", codes: { snomed: ["64859006"] } };
  const cases: [string, Input[], string][] = [
    ["all met, no exclusion", [t2d, insulin], "strong_match"],
    ["exclusion met", [t2d, metformin], "not_eligible"],
    ["inclusion not met", [{ type: inc, kind: "sex", sex: "male" }, insulin], "not_eligible"],
    ["exclusion unknown", [t2d, unknownExclusion], "possible_match"],
    ["supporting condition not recorded", [t2d, osteoporosis], "possible_match"],
    ["primary condition not recorded", [{ ...osteoporosis, primary: true } as Input], "not_eligible"],
    ["blocker wins over unknown", [t2d, unknownExclusion, metformin], "not_eligible"],
  ];
  for (const [name, criteria, verdict] of cases) {
    const r = evaluateStudy(profile(), doc(criteria.map(crit)));
    assert.equal(r.verdict, verdict, name);
    assert.ok(r.reasons.length > 0, name);
  }
  const blocked = evaluateStudy(profile(), doc([crit(t2d), crit(metformin)]));
  assert.deepEqual(blocked.reasons, ["Exclusion applies: Active prescription: 24 HR Metformin hydrochloride 500 MG."]);
  assert.deepEqual(blocked.counts, { met: 2, not_met: 0, unknown: 0 });
  assert.deepEqual(blocked.criteria[1]!.evidence, [{ source: "medication", code: "860975", display: "24 HR Metformin hydrochloride 500 MG", date: "2026-01-01", active: true }]);
});

test("rankStudies: tier order, then fewer structured unknowns, then fewer free-text items, then NCT id", () => {
  const ok = crit({ type: inc, kind: "condition", codes: { snomed: ["44054006"] } });
  const fail = crit({ type: inc, kind: "sex", sex: "male" });
  const missing = (n: number) => Array.from({ length: n }, () => crit({ type: inc, kind: "lab", loinc: "777-3", op: "gt", value: 1, unit: "10*3/uL" }));
  const ft = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `inc-f${i}`, type: "inclusion" as const, text: "x" }));
  const ranked = rankStudies(profile(), [
    doc([fail], [], "NCT00000007"),
    doc([ok, ...missing(1)], ft(5), "NCT00000006"),
    doc([ok, ...missing(2)], [], "NCT00000005"),
    doc([ok], ft(3), "NCT00000004"),
    doc([ok], ft(1), "NCT00000003"),
    doc([ok], [], "NCT00000002"),
    doc([ok], ft(1), "NCT00000001"),
  ]);
  assert.deepEqual(ranked.map((r) => [r.nct_id, r.verdict]), [
    ["NCT00000002", "strong_match"],
    ["NCT00000001", "strong_match"],
    ["NCT00000003", "strong_match"],
    ["NCT00000004", "strong_match"],
    ["NCT00000006", "possible_match"],
    ["NCT00000005", "possible_match"],
    ["NCT00000007", "not_eligible"],
  ]);
});

test("evaluation is deterministic and does not mutate its inputs", () => {
  const p = profile();
  const d = doc([crit({ type: inc, kind: "lab", loinc: "4548-4", op: "gte", value: 7, unit: "%" })], [{ id: "exc-1", type: "exclusion", text: "Pregnancy" }]);
  const before = JSON.stringify([p, d]);
  assert.deepEqual(evaluateStudy(p, d), evaluateStudy(p, d));
  assert.equal(JSON.stringify([p, d]), before);
});
