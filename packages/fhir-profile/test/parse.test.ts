import assert from "node:assert/strict";
import { test } from "node:test";
import { FhirImportError, MAX_BUNDLE_BYTES, ageOn, isPatientProfile, parseBundle, parseBundleText, toDate } from "../src/index.ts";

const AS_OF = new Date("2026-11-16T12:00:00Z");
const SNOMED = "http://snomed.info/sct";
const LOINC = "http://loinc.org";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
const UCUM = "http://unitsofmeasure.org";

type Resource = Record<string, unknown>;

function patient(extra: Resource = {}): Resource {
  return { resourceType: "Patient", id: "p1", gender: "female", birthDate: "1970-11-16", name: [{ family: "Doe", given: ["Jane"] }], ...extra };
}

function bundle(...resources: Resource[]): Resource {
  return { resourceType: "Bundle", type: "collection", entry: resources.map((resource, i) => ({ fullUrl: `urn:uuid:${i}`, resource })) };
}

function condition(code: string, extra: Resource = {}): Resource {
  return {
    resourceType: "Condition",
    clinicalStatus: { coding: [{ code: "active" }] },
    code: { coding: [{ system: SNOMED, code, display: `Condition ${code}` }] },
    onsetDateTime: "2020-01-01T00:00:00Z",
    ...extra,
  };
}

function obs(code: string, value: number, date: string, unit = "%"): Resource {
  return {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: LOINC, code, display: `Lab ${code}` }] },
    effectiveDateTime: date,
    valueQuantity: { value, unit, system: UCUM, code: unit },
  };
}

function med(code: string, status: string, authoredOn = "2026-01-01"): Resource {
  return { resourceType: "MedicationRequest", status, medicationCodeableConcept: { coding: [{ system: RXNORM, code, display: `Drug ${code}` }] }, authoredOn };
}

test("toDate and ageOn handle partial dates and birthdays", () => {
  assert.equal(toDate("2026-10-14T08:09:41+00:00"), "2026-10-14");
  assert.equal(toDate("2026-10"), "2026-10-01");
  assert.equal(toDate("2026"), "2026-01-01");
  assert.equal(toDate("not a date"), null);
  assert.equal(toDate(42), null);
  for (const [birth, on, age] of [
    ["1970-11-16", "2026-11-16", 56],
    ["1970-11-17", "2026-11-16", 55],
    ["1970-12-01", "2026-11-16", 55],
    ["2000-02-29", "2026-02-28", 25],
    ["2000-02-29", "2026-03-01", 26],
  ] as const) {
    assert.equal(ageOn(birth, on), age, `${birth} on ${on}`);
  }
});

test("age, sex and asOf come from the Patient; no identifying fields are kept", () => {
  const profile = parseBundle(bundle(patient()), { asOf: AS_OF });
  assert.equal(profile.asOf, "2026-11-16");
  assert.equal(profile.age, 56);
  assert.equal(profile.sex, "female");
  assert.equal(profile.deceased, false);
  assert.deepEqual(Object.keys(profile).sort(), ["age", "asOf", "conditions", "deceased", "medications", "observations", "schema", "sex", "source"]);
  const json = JSON.stringify(profile);
  for (const s of ["Doe", "Jane", "1970-11-16", "p1"]) assert.ok(!json.includes(s), `profile contains ${s}`);
});

test("sex and age edge cases", () => {
  const cases: [Resource, string, number | null][] = [
    [patient({ gender: "male" }), "male", 56],
    [patient({ gender: "other" }), "other", 56],
    [patient({ gender: undefined }), "unknown", 56],
    [patient({ birthDate: "1970" }), "female", null],
    [patient({ birthDate: undefined }), "female", null],
    [patient({ deceasedDateTime: "2000-11-16T00:00:00Z" }), "female", 30],
  ];
  for (const [p, sex, age] of cases) {
    const profile = parseBundle(bundle(p), { asOf: AS_OF });
    assert.equal(profile.sex, sex);
    assert.equal(profile.age, age, JSON.stringify(p));
  }
  assert.equal(parseBundle(bundle(patient({ deceasedBoolean: true })), { asOf: AS_OF }).deceased, true);
});

test("conditions: active, resolved, abated after asOf, future onset, refuted, merged by code", () => {
  const profile = parseBundle(
    bundle(
      patient(),
      condition("1"),
      condition("2", { clinicalStatus: { coding: [{ code: "resolved" }] }, abatementDateTime: "2024-05-01" }),
      condition("3", { clinicalStatus: { coding: [{ code: "resolved" }] }, abatementDateTime: "2026-12-01" }),
      condition("4", { onsetDateTime: "2027-01-01" }),
      condition("5", { verificationStatus: { coding: [{ code: "refuted" }] } }),
      condition("6", { clinicalStatus: undefined }),
      condition("2", { clinicalStatus: { coding: [{ code: "resolved" }] }, onsetDateTime: "2010-01-01", abatementDateTime: "2011-01-01" }),
      condition("1", { onsetDateTime: "2015-06-01", clinicalStatus: { coding: [{ code: "resolved" }] }, abatementDateTime: "2016-01-01" }),
    ),
    { asOf: AS_OF },
  );
  const byCode = Object.fromEntries(profile.conditions.map((c) => [c.code, c]));
  assert.deepEqual(Object.keys(byCode).sort(), ["1", "2", "3", "6"]);
  assert.deepEqual(byCode["1"], { system: SNOMED, code: "1", display: "Condition 1", onset: "2015-06-01", abatement: null, active: true });
  assert.deepEqual(byCode["2"], { system: SNOMED, code: "2", display: "Condition 2", onset: "2010-01-01", abatement: "2024-05-01", active: false });
  assert.equal(byCode["3"]!.active, true, "abated after asOf: still active on asOf");
  assert.equal(byCode["6"]!.active, true, "no clinicalStatus and no abatement");
});

test("observations: latest per LOINC, components, future and entered-in-error ignored, coded values", () => {
  const bp = {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: LOINC, code: "85354-9", display: "Blood pressure panel" }] },
    effectiveDateTime: "2026-03-01",
    component: [
      { code: { coding: [{ system: LOINC, code: "8480-6", display: "Systolic" }] }, valueQuantity: { value: 132, unit: "mm[Hg]", system: UCUM, code: "mm[Hg]" } },
      { code: { coding: [{ system: LOINC, code: "8462-4", display: "Diastolic" }] }, valueQuantity: { value: 81, unit: "mm[Hg]", system: UCUM, code: "mm[Hg]" } },
    ],
  };
  const smoking = {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: LOINC, code: "72166-2" }] },
    effectiveDateTime: "2026-03-01",
    valueCodeableConcept: { coding: [{ system: SNOMED, code: "8517006", display: "Ex-smoker (finding)" }] },
  };
  const profile = parseBundle(
    bundle(
      patient(),
      obs("4548-4", 7.1, "2025-01-01"),
      obs("4548-4", 8.2, "2026-06-01"),
      obs("4548-4", 6.0, "2026-02-01"),
      obs("4548-4", 9.9, "2027-01-01"),
      { ...obs("4548-4", 12, "2026-10-01"), status: "entered-in-error" },
      bp,
      smoking,
      { ...obs("__proto__", 1, "2026-01-01") },
      // PRAPARE-style free-text answer (Synthea puts the street address here): never kept.
      { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "56799-0" }] }, effectiveDateTime: "2026-03-01", valueString: "1 Main Street" },
    ),
    { asOf: AS_OF },
  );
  assert.deepEqual(profile.observations["4548-4"], { value: 8.2, unit: "%", date: "2026-06-01", display: "Lab 4548-4" });
  assert.deepEqual(profile.observations["8480-6"], { value: 132, unit: "mm[Hg]", date: "2026-03-01", display: "Systolic" });
  assert.equal(profile.observations["8462-4"]?.value, 81);
  assert.equal(profile.observations["85354-9"], undefined, "panel without own value");
  assert.deepEqual(profile.observations["72166-2"], { value: "Ex-smoker (finding)", unit: null, date: "2026-03-01", display: "72166-2" });
  assert.deepEqual(Object.keys(profile.observations), ["4548-4", "72166-2", "8462-4", "8480-6"]);
  assert.equal(Object.getPrototypeOf(profile.observations), Object.prototype);
});

test("medications: only active requests, resolved Medication references, newest authoredOn", () => {
  const profile = parseBundle(
    {
      resourceType: "Bundle",
      type: "collection",
      entry: [
        { fullUrl: "urn:uuid:p", resource: patient() },
        { resource: med("860975", "active", "2025-01-01") },
        { resource: med("860975", "active", "2026-01-01") },
        { resource: med("106892", "stopped") },
        { resource: med("999", "active", "2027-01-01") },
        { fullUrl: "urn:uuid:m1", resource: { resourceType: "Medication", id: "m1", code: { coding: [{ system: RXNORM, code: "314076", display: "lisinopril" }] } } },
        { resource: { resourceType: "MedicationRequest", status: "active", medicationReference: { reference: "urn:uuid:m1" }, authoredOn: "2026-02-02" } },
        { resource: { resourceType: "MedicationRequest", status: "active", medicationReference: { reference: "urn:uuid:missing" } } },
      ],
    },
    { asOf: AS_OF },
  );
  assert.deepEqual(profile.medications, [
    { rxnorm: "314076", display: "lisinopril", status: "active", authoredOn: "2026-02-02" },
    { rxnorm: "860975", display: "Drug 860975", status: "active", authoredOn: "2026-01-01" },
  ]);
});

test("verificationStatus: unconfirmed, provisional and differential are never active; refuted and entered-in-error are dropped", () => {
  const vs = (code: string): Resource => ({ verificationStatus: { coding: [{ code }] } });
  const profile = parseBundle(
    bundle(
      patient(),
      condition("10", vs("confirmed")),
      condition("11", vs("unconfirmed")),
      condition("12", vs("provisional")),
      condition("13", vs("differential")),
      condition("14", vs("refuted")),
      condition("15", vs("entered-in-error")),
      condition("16", vs("provisional")),
      condition("16", { ...vs("confirmed"), onsetDateTime: "2021-01-01" }),
    ),
    { asOf: AS_OF },
  );
  const byCode = Object.fromEntries(profile.conditions.map((c) => [c.code, c]));
  assert.deepEqual(Object.keys(byCode).sort(), ["10", "11", "12", "13", "16"]);
  assert.equal(byCode["10"]!.active, true);
  for (const code of ["11", "12", "13"]) {
    assert.equal(byCode[code]!.active, false, code);
    assert.equal(byCode[code]!.unconfirmed, true, code);
  }
  assert.equal(byCode["16"]!.active, true, "a confirmed record of the same code wins");
  assert.equal(byCode["16"]!.unconfirmed, undefined);
  assert.equal(profile.source.skipped, 2);
});

test("medications: on-hold, completed, stopped, draft and cancelled requests are not active", () => {
  const statuses = ["on-hold", "completed", "stopped", "draft", "cancelled", "entered-in-error", "unknown"];
  const profile = parseBundle(bundle(patient(), ...statuses.map((s) => med("860975", s)), med("314076", "active")), { asOf: AS_OF });
  assert.deepEqual(profile.medications.map((m) => m.rxnorm), ["314076"]);
});

test("observations: a partial date (YYYY-MM) is read as the first of the month", () => {
  const profile = parseBundle(bundle(patient(), obs("4548-4", 7.4, "2024-05")), { asOf: AS_OF });
  assert.deepEqual(profile.observations["4548-4"], { value: 7.4, unit: "%", date: "2024-05-01", display: "Lab 4548-4" });
});

test("deceased patients are flagged; age is taken at death", () => {
  const byDate = parseBundle(bundle(patient({ deceasedDateTime: "2020-11-16T10:00:00Z" })), { asOf: AS_OF });
  assert.equal(byDate.deceased, true);
  assert.equal(byDate.age, 50);
  const alive = parseBundle(bundle(patient({ deceasedBoolean: false })), { asOf: AS_OF });
  assert.equal(alive.deceased, false);
});

test("privacy: display text comes from codings only; free-text and identifying fields never reach the profile", () => {
  const SECRET = "Jane Doe's mother";
  const leaks = [
    SECRET, "NOTE-SECRET", "VALUESTRING-SECRET", "555-0100", "jane@example.org", "42 Secret Lane", "Springfield",
    "MRN-123456", "999-99-9999", "Janeson", "Doe", "Jane", "1970-11-16", "p1", "CONCEPT-TEXT", "VALUE-TEXT", "NARRATIVE",
  ];
  const narrative = { status: "generated", div: "<div>NARRATIVE Jane Doe</div>" };
  const profile = parseBundle(
    bundle(
      patient({
        text: narrative,
        telecom: [{ system: "phone", value: "555-0100" }, { system: "email", value: "jane@example.org" }],
        address: [{ line: ["42 Secret Lane"], city: "Springfield" }],
        identifier: [{ system: "urn:mrn", value: "MRN-123456" }, { system: "http://hl7.org/fhir/sid/us-ssn", value: "999-99-9999" }],
        name: [{ family: "Doe", given: ["Jane"] }, { family: "Janeson", text: "Jane Janeson" }],
      }),
      // A coding without display: the code is shown, never CodeableConcept.text.
      { ...condition("44054006"), text: narrative, code: { text: SECRET, coding: [{ system: SNOMED, code: "44054006" }] }, note: [{ text: "NOTE-SECRET" }] },
      { ...obs("4548-4", 7, "2026-01-01"), code: { text: "CONCEPT-TEXT", coding: [{ system: LOINC, code: "4548-4" }] }, note: [{ text: "NOTE-SECRET" }] },
      { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "72166-2" }] }, effectiveDateTime: "2026-01-01", valueCodeableConcept: { text: "VALUE-TEXT", coding: [{ system: SNOMED, code: "8517006" }] } },
      { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "11331-6" }] }, effectiveDateTime: "2026-01-01", valueCodeableConcept: { text: "VALUE-TEXT" } },
      { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "56799-0" }] }, effectiveDateTime: "2026-01-01", valueString: "VALUESTRING-SECRET" },
      { ...med("860975", "active"), medicationCodeableConcept: { text: SECRET, coding: [{ system: RXNORM, code: "860975" }] }, note: [{ text: "NOTE-SECRET" }] },
    ),
    { asOf: AS_OF },
  );
  const json = JSON.stringify(profile);
  for (const s of leaks) assert.ok(!json.includes(s), `profile contains ${s}`);
  assert.equal(profile.conditions[0]!.display, "44054006");
  assert.equal(profile.observations["4548-4"]!.display, "4548-4");
  assert.equal(profile.observations["72166-2"]!.value, "8517006");
  assert.equal(profile.observations["11331-6"], undefined);
  assert.equal(profile.medications[0]!.display, "860975");
});

test("isPatientProfile accepts a parsed profile and rejects other schemas and shapes", () => {
  const profile = parseBundle(bundle(patient(), condition("1"), med("860975", "active")), { asOf: AS_OF });
  assert.equal(isPatientProfile(profile), true);
  assert.equal(isPatientProfile(JSON.parse(JSON.stringify(profile))), true);
  for (const bad of [
    null,
    "profile",
    [],
    { ...profile, schema: "chartstays.profile/0" },
    { ...profile, asOf: "yesterday" },
    { ...profile, age: "56" },
    { ...profile, sex: "f" },
    { ...profile, deceased: "no" },
    { ...profile, conditions: {} },
    { ...profile, conditions: [{ code: 1 }] },
    { ...profile, observations: [] },
    { ...profile, medications: [null] },
    { ...profile, source: undefined },
  ]) {
    assert.equal(isPatientProfile(bad), false, JSON.stringify(bad)?.slice(0, 80));
  }
});

test("invalid input fails with a clear error", () => {
  const cases: [unknown, string, RegExp][] = [
    [null, "not_bundle", /Bundle object/],
    [[], "not_bundle", /array/],
    [{ resourceType: "Patient" }, "not_bundle", /got a Patient/],
    [{ foo: 1 }, "not_bundle", /resourceType is missing/],
    [{ resourceType: "Bundle" }, "not_bundle", /no entry/],
    [bundle(), "no_patient", /no Patient/],
    [bundle(patient(), patient()), "multiple_patients", /2 Patient/],
    [bundle(patient(), { resourceType: "MedicationOrder" }), "not_r4", /DSTU2\/STU3/],
    [bundle(patient(), { resourceType: "Condition", clinicalStatus: "active" }), "not_r4", /STU3/],
    [bundle(patient(), { resourceType: "MedicationRequest", medication: { concept: {} } }), "not_r4", /R5/],
  ];
  for (const [input, code, message] of cases) {
    assert.throws(() => parseBundle(input, { asOf: AS_OF }), (e: unknown) => e instanceof FhirImportError && e.code === code && message.test(e.message), JSON.stringify(input));
  }
  assert.throws(() => parseBundle(bundle(patient()), { asOf: new Date("nope") }), /asOf must be a valid Date/);
});

test("parseBundleText rejects invalid JSON and oversized files", () => {
  assert.equal(MAX_BUNDLE_BYTES, 20 * 1024 * 1024);
  assert.throws(() => parseBundleText("{not json", { asOf: AS_OF }), (e: unknown) => e instanceof FhirImportError && e.code === "not_json");
  const big = " ".repeat(MAX_BUNDLE_BYTES + 1);
  assert.throws(() => parseBundleText(big, { asOf: AS_OF }), (e: unknown) => e instanceof FhirImportError && e.code === "too_large");
  // Multi-byte text: under the limit in characters, over it in UTF-8 bytes.
  const wide = "é".repeat(MAX_BUNDLE_BYTES / 2 + 1);
  assert.throws(() => parseBundleText(wide, { asOf: AS_OF }), (e: unknown) => e instanceof FhirImportError && e.code === "too_large");
  assert.equal(parseBundleText(JSON.stringify(bundle(patient())), { asOf: AS_OF }).age, 56);
});

test("bundle content is treated as data only", () => {
  const evil = patient({ gender: "female", __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } });
  const text = JSON.stringify(bundle(evil, { resourceType: "Condition", code: { coding: [{ system: SNOMED, code: "1", display: "<script>alert(1)</script>\u0000x".repeat(50) }] } }));
  const profile = parseBundleText(text, { asOf: AS_OF });
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.ok(profile.conditions[0]!.display.length <= 200);
  assert.ok(!profile.conditions[0]!.display.includes("\u0000"));
});
