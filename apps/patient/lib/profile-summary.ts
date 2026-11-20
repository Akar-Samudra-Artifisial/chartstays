// readProfile: the minimal profile summary the in-browser agent may read. Built field by
// field from an explicit allow-list, so a new profile field never leaks into it by default.
// No identifiers, no free text, no exact dates (lab dates are cut to the month). Beyond the
// age band and sex it holds only record items that the loaded trial criteria refer to: the
// intersection of the profile's codes with the codes in those criteria.
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import type { PatientProfile } from "@chartstays/fhir-profile";
import { KEY_LABS } from "./key-labs.ts";

export interface ProfileSummary {
  /** Five-year band such as "60-64"; null when the age is unknown. */
  ageBand: string | null;
  sex: "female" | "male" | "other" | "unknown";
  conditions: { system: "SNOMED CT"; code: string; display: string }[];
  labs: { loinc: string; name: string; value: number; unit: string | null; month: string }[];
  medications: { rxnorm: string; display: string }[];
  note: string;
}

/** The codes the loaded trial criteria refer to. */
export interface CriteriaScope {
  snomed: ReadonlySet<string>;
  loinc: ReadonlySet<string>;
  rxnorm: ReadonlySet<string>;
}

export const EMPTY_SCOPE: CriteriaScope = { snomed: new Set(), loinc: new Set(), rxnorm: new Set() };

const SNOMED = "http://snomed.info/sct";
const MAX_TEXT = 120;
const MAX_CONDITIONS = 40;
const MAX_LABS = 20;
const MAX_MEDICATIONS = 30;
const CODE_RE = /^[0-9A-Za-z.-]{1,32}$/;
// Only diagnoses: findings and situations in Synthea records include social details.
const DIAGNOSIS_RE = /\((disorder|disease)\)$/;
const LAB_NAMES = new Map(KEY_LABS.map(([loinc, name]) => [loinc, name]));

export const SUMMARY_NOTE =
  "Minimal summary for pre-screening in this browser. It holds no name, address, identifier or exact date, and only the record items that the loaded trial criteria refer to. Never send it to another site.";
export const EMPTY_SCOPE_NOTE = "No trial criteria are loaded yet, so only the age band and sex are shown. Load trial nodes first.";

function text(value: string): string {
  // Strip control characters and cap the length: the summary goes into a model prompt.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

export function ageBand(age: number | null): string | null {
  if (age === null || !Number.isFinite(age) || age < 0) return null;
  if (age >= 90) return "90+";
  const low = Math.floor(age / 5) * 5;
  return `${low}-${low + 4}`;
}

/** The codes referred to by structured criteria (age and sex need no code). */
export function criteriaScope(docs: Iterable<CriteriaDocument>): CriteriaScope {
  const snomed = new Set<string>();
  const loinc = new Set<string>();
  const rxnorm = new Set<string>();
  for (const doc of docs) {
    for (const c of doc.structured) {
      if (c.kind === "condition") for (const code of c.codes.snomed) snomed.add(code);
      else if (c.kind === "lab") loinc.add(c.loinc);
      else if (c.kind === "medication") for (const code of c.rxnorm) rxnorm.add(code);
    }
  }
  return { snomed, loinc, rxnorm };
}

export function summarizeProfile(profile: PatientProfile, scope: CriteriaScope = EMPTY_SCOPE): ProfileSummary {
  const conditions = profile.conditions
    .filter((c) => c.system === SNOMED && c.active && c.unconfirmed !== true && CODE_RE.test(c.code) && DIAGNOSIS_RE.test(c.display) && scope.snomed.has(c.code))
    .slice(0, MAX_CONDITIONS)
    .map((c) => ({ system: "SNOMED CT" as const, code: c.code, display: text(c.display) }));

  const labs: ProfileSummary["labs"] = [];
  for (const loinc of [...scope.loinc].sort()) {
    const o = profile.observations[loinc];
    if (labs.length >= MAX_LABS || !CODE_RE.test(loinc)) continue;
    if (o === undefined || typeof o.value !== "number" || !Number.isFinite(o.value) || !/^\d{4}-\d{2}/.test(o.date)) continue;
    labs.push({ loinc, name: text(LAB_NAMES.get(loinc) ?? o.display), value: o.value, unit: o.unit === null ? null : text(o.unit), month: o.date.slice(0, 7) });
  }

  const medications = profile.medications
    .filter((m) => m.status === "active" && CODE_RE.test(m.rxnorm) && scope.rxnorm.has(m.rxnorm))
    .slice(0, MAX_MEDICATIONS)
    .map((m) => ({ rxnorm: m.rxnorm, display: text(m.display) }));

  const sex = (["female", "male", "other"] as const).find((s) => s === profile.sex) ?? "unknown";
  const empty = scope.snomed.size === 0 && scope.loinc.size === 0 && scope.rxnorm.size === 0;
  return { ageBand: ageBand(profile.age), sex, conditions, labs, medications, note: empty ? `${SUMMARY_NOTE} ${EMPTY_SCOPE_NOTE}` : SUMMARY_NOTE };
}
