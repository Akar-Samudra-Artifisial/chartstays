// Real Synthea bundles from data/synthea/patients: the parser must agree with a direct
// reading of the raw resources, and the profile must not carry identifying data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseBundle, type PatientProfile } from "../src/index.ts";

const DIR = new URL("../../../data/synthea/patients/", import.meta.url);
const AS_OF = new Date("2026-11-16T00:00:00Z");

interface RawCoding { system?: string; code?: string }
interface Resource {
  resourceType: string;
  id?: string;
  gender?: string;
  birthDate?: string;
  code?: { coding: RawCoding[] };
  clinicalStatus?: { coding?: RawCoding[] };
  valueQuantity?: { value: number; code?: string };
  effectiveDateTime?: string;
  name?: { family?: string; given?: string[]; prefix?: string[] }[];
  address?: { line?: string[]; city?: string; postalCode?: string }[];
  telecom?: { value?: string }[];
  identifier?: { value?: string }[];
  extension?: { valueString?: unknown }[];
}
interface RawBundle { resourceType: "Bundle"; entry: { resource: Resource }[] }

function load(file: string): { bundle: RawBundle; resources: Resource[] } {
  const bundle = JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as RawBundle;
  return { bundle, resources: bundle.entry.map((e) => e.resource) };
}

const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "index.json").sort();

test("the Synthea subset is present", () => {
  assert.equal(FILES.length, 8);
});

test("Marlin805 (male, b. 1966-02-18): age, type 2 diabetes, latest HbA1c and eGFR", () => {
  const file = FILES.find((f) => f.startsWith("Marlin805_"))!;
  const { bundle, resources } = load(file);
  const profile = parseBundle(bundle, { asOf: AS_OF });
  assert.equal(profile.age, 60);
  assert.equal(profile.sex, "male");
  const t2d = profile.conditions.find((c) => c.code === "44054006");
  assert.ok(t2d?.active, "type 2 diabetes is active");

  // Latest HbA1c and eGFR read straight from the raw Observations.
  for (const loinc of ["4548-4", "33914-3", "39156-5"]) {
    const latest = resources
      .filter((r) => r.resourceType === "Observation" && r.code?.coding.some((c) => c.code === loinc) && r.valueQuantity)
      .sort((a, b) => ((a.effectiveDateTime ?? "") < (b.effectiveDateTime ?? "") ? -1 : 1))
      .at(-1)!;
    assert.deepEqual(
      { value: profile.observations[loinc]?.value, unit: profile.observations[loinc]?.unit, date: profile.observations[loinc]?.date },
      { value: latest.valueQuantity?.value, unit: latest.valueQuantity?.code, date: latest.effectiveDateTime?.slice(0, 10) },
      loinc,
    );
  }
  assert.ok(profile.medications.some((m) => m.rxnorm === "860975"), "metformin is active");
});

test("every subset patient parses; age and active conditions match the raw data", () => {
  for (const file of FILES) {
    const { bundle, resources } = load(file);
    const profile = parseBundle(bundle, { asOf: AS_OF });
    const raw = resources.find((r) => r.resourceType === "Patient")!;
    assert.equal(profile.sex, raw.gender, file);
    const [y, m, d] = (raw.birthDate as string).split("-").map(Number) as [number, number, number];
    const expectedAge = 2026 - y - (m > 11 || (m === 11 && d > 16) ? 1 : 0);
    assert.equal(profile.age, expectedAge, file);
    const rawActive = new Set(
      resources
        .filter((r) => r.resourceType === "Condition" && r.clinicalStatus?.coding?.[0]?.code === "active")
        .map((r) => r.code?.coding[0]?.code ?? ""),
    );
    const active = new Set(profile.conditions.filter((c) => c.active).map((c) => c.code));
    assert.deepEqual([...active].sort(), [...rawActive].sort(), file);
  }
});

function identifyingStrings(patient: Resource): string[] {
  const out: unknown[] = [patient.id, patient.birthDate];
  for (const name of patient.name ?? []) out.push(name.family, ...(name.given ?? []), ...(name.prefix ?? []));
  for (const address of patient.address ?? []) out.push(...(address.line ?? []), address.city, address.postalCode);
  for (const telecom of patient.telecom ?? []) out.push(telecom.value);
  for (const identifier of patient.identifier ?? []) out.push(identifier.value);
  for (const ext of patient.extension ?? []) if (typeof ext.valueString === "string") out.push(ext.valueString);
  return out.filter((s): s is string => typeof s === "string" && s.length >= 3);
}

test("privacy: profiles hold no name, address, telecom, identifier, birth date or patient id", () => {
  for (const file of FILES) {
    const { bundle, resources } = load(file);
    const profile: PatientProfile = parseBundle(bundle, { asOf: AS_OF });
    const json = JSON.stringify(profile);
    const patient = resources.find((r) => r.resourceType === "Patient")!;
    const strings = identifyingStrings(patient);
    assert.ok(strings.length >= 5, `${file}: expected identifying strings to check`);
    for (const s of strings) assert.ok(!json.includes(s), `${file}: profile contains "${s}"`);
    // Resource ids and references would link back to the source record.
    assert.ok(!json.includes("urn:uuid:"), `${file}: profile contains a reference`);
  }
});
