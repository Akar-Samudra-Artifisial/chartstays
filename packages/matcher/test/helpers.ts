import type { CriteriaDocument, FreeTextCriterion, StructuredCriterion } from "@chartstays/criteria-schema";
import type { PatientProfile } from "@chartstays/fhir-profile";

export const SNOMED = "http://snomed.info/sct";

export function profile(overrides: Partial<PatientProfile> = {}): PatientProfile {
  return {
    schema: "chartstays.profile/1",
    asOf: "2026-11-16",
    age: 55,
    sex: "female",
    deceased: false,
    conditions: [
      { system: SNOMED, code: "44054006", display: "Diabetes mellitus type 2 (disorder)", onset: "2015-03-01", abatement: null, active: true },
      { system: SNOMED, code: "254837009", display: "Malignant neoplasm of breast (disorder)", onset: "2018-01-01", abatement: "2020-01-01", active: false },
    ],
    observations: {
      "4548-4": { value: 7.5, unit: "%", date: "2026-10-01", display: "Hemoglobin A1c" },
      "33914-3": { value: 45, unit: "mL/min/{1.73_m2}", date: "2026-10-01", display: "eGFR" },
      "718-7": { value: 100, unit: "g/L", date: "2026-10-01", display: "Hemoglobin" },
      "39156-5": { value: 30, unit: "kg/m2", date: "2025-11-16", display: "BMI" },
      "2571-8": { value: 150, unit: "mg/dL", date: "2025-11-15", display: "Triglycerides" },
      "1751-7": { value: 4, unit: "g/dL", date: "2026-10-01", display: "Albumin" },
      "14959-1": { value: 30, unit: "mg/mmol", date: "2026-10-01", display: "ACR" },
      "2823-3": { value: 4.5, unit: "mEq/L", date: "2026-10-01", display: "Potassium" },
      "6298-4": { value: 5.2, unit: "mmol/L", date: "2026-10-01", display: "Potassium blood" },
      "72166-2": { value: "Never smoked tobacco (finding)", unit: null, date: "2026-10-01", display: "Tobacco smoking status" },
      "29463-7": { value: 70, unit: "furlong", date: "2026-10-01", display: "Body weight" },
    },
    medications: [{ rxnorm: "860975", display: "24 HR Metformin hydrochloride 500 MG", status: "active", authoredOn: "2026-01-01" }],
    source: { format: "FHIR R4 Bundle", resources: {}, skipped: 0 },
    ...overrides,
  };
}

let seq = 0;
type StructuredInput = { [K in StructuredCriterion["kind"]]: Omit<Extract<StructuredCriterion, { kind: K }>, "id" | "label" | "source_text"> & Partial<Pick<StructuredCriterion, "id" | "label" | "source_text">> }[StructuredCriterion["kind"]];

export function crit(c: StructuredInput): StructuredCriterion {
  seq += 1;
  const prefix = c.type === "inclusion" ? "inc" : "exc";
  return { id: `${prefix}-${seq}`, label: `criterion ${seq}`, source_text: "", ...c } as StructuredCriterion;
}

export function doc(structured: StructuredCriterion[], freeText: FreeTextCriterion[] = [], nct = "NCT00000001"): CriteriaDocument {
  return {
    schema_version: 1,
    nct_id: nct,
    title: `Study ${nct}`,
    status: "RECRUITING",
    conditions: [],
    source: { name: "ClinicalTrials.gov", nct_id: nct, url: `https://clinicaltrials.gov/study/${nct}`, retrieved: "2026-11-16", modified: "test" },
    eligibility: { criteria_text: "", sex: "ALL", minimum_age: null, maximum_age: null },
    structured,
    free_text: freeText,
    requested_fields_for_inquiry: [],
  };
}
