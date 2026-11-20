import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCriteria } from "@chartstays/criteria-schema";
import { criteriaSourceFrom, logisticsFrom, parseCtgovAge, type Snapshot } from "../src/ctgov.ts";
import { curate, matchesCuration } from "../src/curate.ts";
import { splitEligibility, splitInlineNumbering, unescapeCtgov } from "../src/eligibility.ts";

function snapshot(): Snapshot {
  return {
    retrieved: "2026-11-16",
    api_version: "2.0.5",
    request_url: "https://clinicaltrials.gov/api/v2/studies?filter.ids=NCT01234567",
    study: {
      protocolSection: {
        identificationModule: { nctId: "NCT01234567", briefTitle: "Example study" },
        statusModule: { overallStatus: "RECRUITING", lastUpdatePostDateStruct: { date: "2026-10-01" } },
        conditionsModule: { conditions: ["Type 2 Diabetes"] },
        eligibilityModule: {
          eligibilityCriteria: "Inclusion Criteria:\n\n* Age 18 to 75\n* HbA1c \\>= 7%\n  * measured at screening\n\nExclusion Criteria:\n\n* Type 1 diabetes\n* On insulin",
          sex: "FEMALE",
          minimumAge: "18 Years",
          maximumAge: "75 Years",
          healthyVolunteers: false,
        },
        contactsLocationsModule: { locations: [{ facility: "Site A", city: "Boston", country: "United States", status: "RECRUITING" }] },
      },
    },
  };
}

test("parseCtgovAge reads years and months", () => {
  assert.equal(parseCtgovAge("18 Years"), 18);
  assert.equal(parseCtgovAge("1 Year"), 1);
  assert.equal(parseCtgovAge("6 Months"), 0.5);
  assert.equal(parseCtgovAge("2 Weeks"), 0.04);
});

test("parseCtgovAge treats empty or missing as no limit", () => {
  assert.equal(parseCtgovAge(""), null);
  assert.equal(parseCtgovAge("   "), null);
  assert.equal(parseCtgovAge(undefined), null);
  assert.equal(parseCtgovAge(null), null);
  assert.equal(parseCtgovAge("N/A"), null);
});

test("parseCtgovAge rejects unknown formats", () => {
  assert.throws(() => parseCtgovAge("eighteen"), /Unrecognised/);
  assert.throws(() => parseCtgovAge("18 Decades"), /Unrecognised/);
});

test("criteriaSourceFrom maps the snapshot to the attribution block", () => {
  assert.deepEqual(criteriaSourceFrom(snapshot()), {
    name: "ClinicalTrials.gov",
    nct_id: "NCT01234567",
    url: "https://clinicaltrials.gov/study/NCT01234567",
    retrieved: "2026-11-16",
    last_update_posted: "2026-10-01",
    modified: criteriaSourceFrom(snapshot()).modified,
  });
  assert.match(criteriaSourceFrom(snapshot()).modified, /original text is kept unchanged/);
});

test("logistics carries locations and no contact details", () => {
  const logistics = logisticsFrom(snapshot());
  assert.equal(logistics.location_count, 1);
  assert.match(String(logistics.contacts), /clinicaltrials\.gov\/study\/NCT01234567/);
});

test("splitEligibility numbers lines per section and joins sub-bullets", () => {
  const lines = splitEligibility(snapshot().study.protocolSection.eligibilityModule.eligibilityCriteria!);
  assert.deepEqual(lines, [
    { id: "inc-1", type: "inclusion", text: "Age 18 to 75" },
    { id: "inc-2", type: "inclusion", text: "HbA1c >= 7%; measured at screening" },
    { id: "exc-1", type: "exclusion", text: "Type 1 diabetes" },
    { id: "exc-2", type: "exclusion", text: "On insulin" },
  ]);
  assert.equal(unescapeCtgov("eGFR \\< 30 &amp; BMI &gt; 40"), "eGFR < 30 & BMI > 40");
});

test("curate builds a valid document and keeps the original text", () => {
  const snap = snapshot();
  const doc = curate(snap, {
    nct_id: "NCT01234567",
    map: [
      { from: "inc-1", match: "Age 18", covered_by: "inc-0a" },
      { from: "inc-2", match: "HbA1c", structured: [{ kind: "lab", label: "HbA1c 7% or higher", loinc: "4548-4", op: "gte", value: 7, unit: "%" }] },
      { from: "exc-2", match: "insulin", keep_free_text: true, structured: [{ kind: "medication", label: "Insulin", rxnorm: ["106892"] }] },
    ],
  });
  assert.deepEqual(validateCriteria(doc), { valid: true, errors: [] });
  assert.equal(doc.eligibility.criteria_text, snap.study.protocolSection.eligibilityModule.eligibilityCriteria);
  assert.deepEqual(doc.structured.map((c) => `${c.id}:${c.kind}`), ["inc-0a:age", "inc-0b:sex", "inc-2:lab", "exc-2a:medication"]);
  assert.deepEqual(doc.free_text.map((c) => c.id), ["exc-1", "exc-2"]);
  assert.deepEqual(doc.requested_fields_for_inquiry, ["age", "sex", "labs:4548-4", "medications"]);
});

test("splitEligibility splits numbered criteria run into one paragraph", () => {
  const raw = "Inclusion Criteria:\n\n1. Aged 18-75 years;\n2. Diagnosed with renal anemia:\n\n1)Hemoglobin 6 - 10 g/dL; 2)Hemoglobin 8 - 12 g/dL; 5. Serum ferritin \\> 100 μg/L at screening. 6. Voluntary participation.\n\nExclusion Criteria:\n\n1. eGFR 2. 5 is not a split; HbA1c 7. 5% neither";
  assert.deepEqual(splitEligibility(raw), [
    { id: "inc-1", type: "inclusion", text: "Aged 18-75 years;" },
    { id: "inc-2", type: "inclusion", text: "Diagnosed with renal anemia: 1)Hemoglobin 6 - 10 g/dL; 2)Hemoglobin 8 - 12 g/dL" },
    { id: "inc-3", type: "inclusion", text: "Serum ferritin > 100 μg/L at screening" },
    { id: "inc-4", type: "inclusion", text: "Voluntary participation." },
    { id: "exc-1", type: "exclusion", text: "eGFR 2. 5 is not a split; HbA1c 7. 5% neither" },
  ]);
  assert.deepEqual(splitInlineNumbering("A; 5. Bb; 6. Cc"), ["A", "Bb", "Cc"]);
});

test("criteriaSourceFrom states the curation is not clinician-reviewed", () => {
  assert.match(criteriaSourceFrom(snapshot()).modified, /criteria curated by the project team, not reviewed by clinicians; pre-screening only/i);
});

test("covered_by inc-0a needs the line to state the age limits", () => {
  const snap = snapshot();
  snap.study.protocolSection.eligibilityModule.eligibilityCriteria = "Inclusion Criteria:\n\n* Age 18 to 65\n* Adults aged 18 or older";
  assert.throws(
    () => curate(snap, { nct_id: "NCT01234567", map: [{ from: "inc-1", match: "Age", covered_by: "inc-0a" }] }),
    /does not state age 75/,
  );
  assert.throws(
    () => curate(snap, { nct_id: "NCT01234567", map: [{ from: "inc-2", match: "Adults", covered_by: "inc-0a" }] }),
    /does not state age 75/,
  );
});

test("a single-product medication needs keep_free_text", () => {
  const map = (keep: boolean) => ({
    nct_id: "NCT01234567",
    map: [{ from: "exc-2", match: "insulin", keep_free_text: keep, structured: [{ kind: "medication" as const, label: "Insulin", rxnorm: ["106892"] }] }],
  });
  assert.throws(() => curate(snapshot(), map(false)), /single product 106892; set keep_free_text/);
  assert.doesNotThrow(() => curate(snapshot(), map(true)));
});

test("group_logic puts a line's criteria in one validated group", () => {
  const lab = (loinc: string) => ({ kind: "lab" as const, label: `K ${loinc}`, loinc, op: "gt" as const, value: 4.9, unit: "mmol/L" });
  const doc = curate(snapshot(), {
    nct_id: "NCT01234567",
    map: [{ from: "exc-1", match: "Type 1", group_logic: "any", structured: [lab("2823-3"), lab("6298-4")] }],
  });
  const grouped = doc.structured.filter((c) => c.group !== undefined);
  assert.deepEqual(grouped.map((c) => [c.id, c.group, c.group_logic]), [["exc-1a", "exc-1", "any"], ["exc-1b", "exc-1", "any"]]);
  assert.deepEqual(validateCriteria(doc), { valid: true, errors: [] });
  assert.throws(
    () => curate(snapshot(), { nct_id: "NCT01234567", map: [{ from: "exc-1", match: "Type 1", group_logic: "any", structured: [lab("2823-3")] }] }),
    /fewer than two criteria/,
  );
});

test("matchesCuration flags a stale criteria file", () => {
  const map = { nct_id: "NCT01234567", map: [{ from: "inc-1", match: "Age 18", covered_by: "inc-0a" as const }] };
  const fresh = curate(snapshot(), map);
  const onDisk = JSON.parse(JSON.stringify(fresh)) as typeof fresh;
  assert.equal(matchesCuration(onDisk, fresh), true);
  assert.equal(matchesCuration({ ...onDisk, free_text: onDisk.free_text.slice(1) }, fresh), false);
  assert.equal(matchesCuration({ ...onDisk, structured: [] }, fresh), false);
});

test("curate refuses a map that no longer fits the record", () => {
  assert.throws(
    () => curate(snapshot(), { nct_id: "NCT01234567", map: [{ from: "inc-2", match: "eGFR", covered_by: "inc-0a" }] }),
    /no longer contains/,
  );
});
