import assert from "node:assert/strict";
import { test } from "node:test";
import { hasNonAgeStructured, validateCriteria, type CriteriaDocument } from "../src/index.ts";

function validDoc(): CriteriaDocument {
  return {
    schema_version: 1,
    nct_id: "NCT01234567",
    title: "Example study",
    status: "RECRUITING",
    conditions: ["Type 2 Diabetes"],
    source: {
      name: "ClinicalTrials.gov",
      nct_id: "NCT01234567",
      url: "https://clinicaltrials.gov/study/NCT01234567",
      retrieved: "2026-11-16",
      last_update_posted: "2026-10-01",
      modified: "Structured by ChartStays.",
    },
    eligibility: {
      criteria_text: "Inclusion Criteria:\n\n* HbA1c 7-10%",
      sex: "ALL",
      minimum_age: "18 Years",
      maximum_age: null,
      healthy_volunteers: false,
    },
    structured: [
      { id: "inc-0a", type: "inclusion", kind: "age", label: "Age 18 or older", source_text: "18 Years", min: 18, max: null, unit: "years" },
      { id: "inc-1", type: "inclusion", kind: "lab", label: "HbA1c 7 to 10%", source_text: "HbA1c 7-10%", loinc: "4548-4", op: "between", value: [7, 10], unit: "%" },
      { id: "exc-1", type: "exclusion", kind: "medication", label: "Insulin", source_text: "On insulin", rxnorm: ["106892"] },
      { id: "inc-2", type: "inclusion", kind: "condition", label: "Type 2 diabetes", source_text: "T2D", codes: { snomed: ["44054006"] } },
    ],
    free_text: [{ id: "exc-2", type: "exclusion", text: "Pregnancy" }],
    requested_fields_for_inquiry: ["age", "labs:4548-4", "medications", "conditions"],
    curation: { method: "manual" },
  };
}

test("a complete document is valid", () => {
  const result = validateCriteria(validDoc());
  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(hasNonAgeStructured(validDoc()), true);
});

test("missing source block is invalid", () => {
  const doc: Partial<CriteriaDocument> = validDoc();
  delete doc.source;
  const result = validateCriteria(doc);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("source")), result.errors.join("; "));
});

test("source must name ClinicalTrials.gov and point at the study", () => {
  const doc = validDoc();
  assert.equal(validateCriteria({ ...doc, source: { ...doc.source, name: "Other" } }).valid, false);
  assert.equal(validateCriteria({ ...doc, source: { ...doc.source, url: "https://example.com/NCT01234567" } }).valid, false);
});

test("unknown criterion kind is invalid", () => {
  const doc = validDoc();
  const bad = { ...doc, structured: [...doc.structured, { id: "inc-9", type: "inclusion", kind: "genotype", label: "x", source_text: "x" }] };
  assert.equal(validateCriteria(bad).valid, false);
});

test("between needs a range and a single op needs a number", () => {
  const doc = validDoc();
  const lab = doc.structured[1]!;
  assert.equal(validateCriteria({ ...doc, structured: [{ ...lab, value: 7 }] }).valid, false);
  assert.equal(validateCriteria({ ...doc, structured: [{ ...lab, op: "gte", value: [7, 10] }] }).valid, false);
});

test("bad NCT id, duplicate ids and mismatched id prefixes are rejected", () => {
  const doc = validDoc();
  assert.equal(validateCriteria({ ...doc, nct_id: "NCT123" }).valid, false);
  const dup = validateCriteria({ ...doc, free_text: [{ id: "inc-1", type: "inclusion", text: "dup" }] });
  assert.equal(dup.valid, false);
  assert.ok(dup.errors.some((e) => e.includes("duplicate")));
  const prefix = validateCriteria({ ...doc, free_text: [{ id: "inc-7", type: "exclusion", text: "x" }] });
  assert.equal(prefix.valid, false);
});

test("reversed age and lab ranges are rejected", () => {
  const doc = validDoc();
  const age = { ...doc.structured[0]!, min: 80, max: 18 };
  assert.equal(validateCriteria({ ...doc, structured: [age] }).valid, false);
  const lab = { ...doc.structured[1]!, value: [10, 7] };
  assert.equal(validateCriteria({ ...doc, structured: [lab] }).valid, false);
});

test("primary is accepted only as true on inclusion conditions", () => {
  const doc = validDoc();
  const cond = { ...doc.structured[3]!, primary: true };
  assert.deepEqual(validateCriteria({ ...doc, structured: [cond] }), { valid: true, errors: [] });
  assert.equal(validateCriteria({ ...doc, structured: [{ ...cond, primary: false }] }).valid, false);
  const exc = { ...cond, id: "exc-9", type: "exclusion" };
  assert.deepEqual(validateCriteria({ ...doc, structured: [exc] }).errors, ["exc-9: primary is only allowed on inclusion conditions"]);
  assert.equal(validateCriteria({ ...doc, structured: [{ ...doc.structured[1]!, primary: true }] }).valid, false);
});

test("logic groups need both fields, two members and one type and logic", () => {
  const doc = validDoc();
  const a = { id: "exc-5a", type: "exclusion", kind: "lab", label: "K > 5.5", source_text: "K > 5.5", loinc: "6298-4", op: "gt", value: 5.5, unit: "mmol/L", group: "exc-5", group_logic: "any" } as const;
  const b = { ...a, id: "exc-5b", loinc: "2823-3" };
  assert.deepEqual(validateCriteria({ ...doc, structured: [...doc.structured, a, b] }), { valid: true, errors: [] });
  const { group_logic: _logic, ...noLogic } = b;
  assert.equal(validateCriteria({ ...doc, structured: [...doc.structured, a, noLogic] }).valid, false);
  const { group: _group, ...noGroup } = b;
  assert.equal(validateCriteria({ ...doc, structured: [...doc.structured, a, noGroup] }).valid, false);
  assert.equal(validateCriteria({ ...doc, structured: [...doc.structured, a] }).valid, false);
  assert.equal(validateCriteria({ ...doc, structured: [...doc.structured, a, { ...b, group_logic: "all" }] }).valid, false);
  assert.equal(validateCriteria({ ...doc, structured: [...doc.structured, a, { ...b, group_logic: "some" }] }).valid, false);
});

test("a document with only an age criterion has no non-age criterion", () => {
  const doc = validDoc();
  assert.equal(hasNonAgeStructured({ ...doc, structured: [doc.structured[0]!] }), false);
});

test("the precompiled validator (no eval) agrees with the run-time compiled one", async () => {
  const { validateCriteriaPrecompiled } = await import("../dist/precompiled.js");
  const broken: unknown[] = [
    validDoc(),
    { ...validDoc(), source: undefined },
    { ...validDoc(), nct_id: "NCT1" },
    { ...validDoc(), title: "x".repeat(5000) },
    { ...validDoc(), structured: [{ id: "inc-9", type: "inclusion", kind: "nope", label: "x", source_text: "x" }] },
    { ...validDoc(), structured: [...validDoc().structured, validDoc().structured[0]] },
  ];
  for (const doc of broken) assert.deepEqual(validateCriteriaPrecompiled(doc).valid, validateCriteria(doc).valid);
  assert.equal(validateCriteriaPrecompiled(validDoc()).valid, true);
});
