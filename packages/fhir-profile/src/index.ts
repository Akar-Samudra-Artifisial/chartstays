// FHIR R4 Bundle -> ChartStays patient profile. The bundle is untrusted input: it is only
// read as data (JSON.parse, property reads), every code is checked against a strict
// pattern before it becomes a key, and free text is trimmed. No network, no eval.

import {
  PROFILE_SCHEMA,
  type ParseOptions,
  type PatientProfile,
  type ProfileCondition,
  type ProfileMedication,
  type ProfileObservation,
  type ProfileSex,
} from "./types.ts";

export * from "./types.ts";

/** Largest bundle text accepted by parseBundleText (bytes, UTF-8). */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
/** Largest number of entries accepted by parseBundle. */
export const MAX_BUNDLE_ENTRIES = 500_000;

export const SYSTEMS = {
  snomed: "http://snomed.info/sct",
  loinc: "http://loinc.org",
  rxnorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
  ucum: "http://unitsofmeasure.org",
} as const;

export type FhirImportErrorCode =
  | "invalid_option"
  | "not_json"
  | "too_large"
  | "not_bundle"
  | "not_r4"
  | "no_patient"
  | "multiple_patients";

export class FhirImportError extends Error {
  readonly code: FhirImportErrorCode;
  constructor(code: FhirImportErrorCode, message: string) {
    super(message);
    this.name = "FhirImportError";
    this.code = code;
  }
}

type Json = Record<string, unknown>;

const LOINC_RE = /^\d{1,7}-\d$/;
const RXNORM_RE = /^\d{1,10}$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,31}$/;
const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/;
const RESOURCE_TYPE_RE = /^[A-Z][A-Za-z]{1,63}$/;
const MAX_TEXT = 200;
const ACTIVE_CLINICAL = new Set(["active", "recurrence", "relapse"]);
const SKIPPED_OBSERVATION_STATUS = new Set(["entered-in-error", "cancelled"]);
const SKIPPED_VERIFICATION = new Set(["entered-in-error", "refuted"]);
// Kept, but never counted as active.
const UNCONFIRMED_VERIFICATION = new Set(["unconfirmed", "provisional", "differential"]);
// Resource types that exist only before R4 (DSTU2 / STU3).
const PRE_R4_TYPES = new Set(["MedicationOrder", "DiagnosticOrder", "ProcedureRequest", "ReferralRequest", "DeviceUseRequest"]);

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Drop control characters, collapse whitespace, cap the length.
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

/** FHIR date / dateTime -> YYYY-MM-DD (missing month or day -> 01); null when unusable. */
export function toDate(value: unknown): string | null {
  const text = str(value);
  if (text === undefined) return null;
  const m = DATE_RE.exec(text);
  if (m === null) return null;
  const month = m[2] ?? "01";
  const day = m[3] ?? "01";
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
  return `${m[1]}-${month}-${day}`;
}

/** Whole years between a full birth date and a date, both YYYY-MM-DD. */
export function ageOn(birthDate: string, on: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function codings(concept: unknown): Json[] {
  return isRecord(concept) ? records(concept["coding"]) : [];
}

// Display text comes from the coding only, never from CodeableConcept.text: that field is
// free text written by a person and can name the patient or a relative.
function codesOf(concept: unknown, system: string, pattern: RegExp): { code: string; display: string }[] {
  const out: { code: string; display: string }[] = [];
  for (const coding of codings(concept)) {
    const code = str(coding["code"]);
    if (coding["system"] !== system || code === undefined || !pattern.test(code)) continue;
    out.push({ code, display: cleanText(coding["display"]) || code });
  }
  return out;
}

function statusCode(concept: unknown): string | undefined {
  for (const coding of codings(concept)) {
    const code = str(coding["code"]);
    if (code !== undefined) return code;
  }
  return undefined;
}

function checkBundle(input: unknown): Json[] {
  if (!isRecord(input)) throw new FhirImportError("not_bundle", "Expected a FHIR Bundle object, got " + (Array.isArray(input) ? "an array" : typeof input) + ".");
  if (input["resourceType"] !== "Bundle") {
    const type = str(input["resourceType"]);
    throw new FhirImportError("not_bundle", type === undefined ? "Not a FHIR resource: resourceType is missing." : `Expected a FHIR Bundle, got a ${cleanText(type).slice(0, 40)} resource.`);
  }
  if (!Array.isArray(input["entry"])) throw new FhirImportError("not_bundle", "The Bundle has no entry list.");
  if (input["entry"].length > MAX_BUNDLE_ENTRIES) {
    throw new FhirImportError("too_large", `The Bundle has ${input["entry"].length} entries; the limit is ${MAX_BUNDLE_ENTRIES}.`);
  }
  return records(input["entry"]);
}

function checkR4(resource: Json, type: string): void {
  if (PRE_R4_TYPES.has(type)) throw new FhirImportError("not_r4", `The Bundle contains ${type}, a resource from FHIR DSTU2/STU3; only FHIR R4 is supported.`);
  if (type === "Condition" && typeof resource["clinicalStatus"] === "string") {
    throw new FhirImportError("not_r4", "Condition.clinicalStatus is a plain code (FHIR STU3); only FHIR R4 is supported.");
  }
  if (type === "MedicationRequest" && "medication" in resource && !("medicationCodeableConcept" in resource) && !("medicationReference" in resource)) {
    throw new FhirImportError("not_r4", "MedicationRequest.medication is a CodeableReference (FHIR R5); only FHIR R4 is supported.");
  }
}

function asOfDate(opts: ParseOptions): string {
  if (!isRecord(opts) || !(opts.asOf instanceof Date) || Number.isNaN(opts.asOf.getTime())) {
    throw new FhirImportError("invalid_option", "options.asOf must be a valid Date.");
  }
  return opts.asOf.toISOString().slice(0, 10);
}

/** Parse bundle JSON text (size-checked) into a profile. */
export function parseBundleText(text: string, opts: ParseOptions): PatientProfile {
  if (typeof text !== "string") throw new FhirImportError("not_json", "Expected the file contents as text.");
  if (text.length > MAX_BUNDLE_BYTES || (text.length * 3 > MAX_BUNDLE_BYTES && utf8Length(text) > MAX_BUNDLE_BYTES)) {
    throw new FhirImportError("too_large", `The file is larger than ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FhirImportError("not_json", "The file is not valid JSON.");
  }
  return parseBundle(data, opts);
}

/** Build a de-identified profile from a parsed FHIR R4 Bundle. */
export function parseBundle(bundle: unknown, opts: ParseOptions): PatientProfile {
  const asOf = asOfDate(opts);
  const entries = checkBundle(bundle);

  const resources: Json[] = [];
  const counts: Record<string, number> = {};
  const medicationsByRef = new Map<string, Json>();
  for (const entry of entries) {
    const resource = entry["resource"];
    if (!isRecord(resource)) continue;
    const type = str(resource["resourceType"]);
    if (type === undefined) continue;
    checkR4(resource, type);
    const key = RESOURCE_TYPE_RE.test(type) ? type : "other";
    counts[key] = (counts[key] ?? 0) + 1;
    resources.push(resource);
    if (type === "Medication") {
      const fullUrl = str(entry["fullUrl"]);
      const id = str(resource["id"]);
      if (fullUrl !== undefined) medicationsByRef.set(fullUrl, resource);
      if (id !== undefined) medicationsByRef.set(`Medication/${id}`, resource);
    }
  }

  const patients = resources.filter((r) => r["resourceType"] === "Patient");
  if (patients.length === 0) throw new FhirImportError("no_patient", "The Bundle has no Patient resource.");
  if (patients.length > 1) throw new FhirImportError("multiple_patients", `The Bundle has ${patients.length} Patient resources; import one patient at a time.`);
  const patient = patients[0]!;

  let skipped = 0;
  const conditions = new Map<string, ProfileCondition>();
  const observations = new Map<string, ProfileObservation>();
  const medications = new Map<string, ProfileMedication>();

  for (const resource of resources) {
    const type = resource["resourceType"];
    if (type === "Condition") {
      if (!readCondition(resource, asOf, conditions)) skipped += 1;
    } else if (type === "Observation") {
      if (!readObservation(resource, asOf, observations)) skipped += 1;
    } else if (type === "MedicationRequest") {
      if (!readMedication(resource, asOf, medications, medicationsByRef)) skipped += 1;
    } else if (type !== "Patient" && type !== "Medication") {
      skipped += 1;
    }
  }

  const { age, deceased } = readAge(patient, asOf);
  const sortedLoinc = [...observations.keys()].sort();
  const observationRecord: Record<string, ProfileObservation> = {};
  for (const code of sortedLoinc) observationRecord[code] = observations.get(code)!;

  return {
    schema: PROFILE_SCHEMA,
    asOf,
    age,
    sex: readSex(patient),
    deceased,
    conditions: [...conditions.values()].sort((a, b) => (a.system === b.system ? compare(a.code, b.code) : compare(a.system, b.system))),
    observations: observationRecord,
    medications: [...medications.values()].sort((a, b) => compare(a.rxnorm, b.rxnorm)),
    source: { format: "FHIR R4 Bundle", resources: sortObject(counts), skipped },
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortObject(input: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(input).sort()) out[key] = input[key]!;
  return out;
}

function readSex(patient: Json): ProfileSex {
  const gender = patient["gender"];
  return gender === "female" || gender === "male" || gender === "other" ? gender : "unknown";
}

function readAge(patient: Json, asOf: string): { age: number | null; deceased: boolean } {
  const deathDate = toDate(patient["deceasedDateTime"]);
  const deceased = deathDate !== null || patient["deceasedBoolean"] === true;
  const birth = str(patient["birthDate"]);
  // Only a full birth date gives an exact age; a partial one gives null (matcher: unknown).
  if (birth === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(birth) || toDate(birth) === null) return { age: null, deceased };
  const on = deathDate !== null && deathDate < asOf ? deathDate : asOf;
  const age = ageOn(birth, on);
  return { age: age >= 0 && age < 150 ? age : null, deceased };
}

function readCondition(resource: Json, asOf: string, out: Map<string, ProfileCondition>): boolean {
  const verification = statusCode(resource["verificationStatus"]);
  if (verification !== undefined && SKIPPED_VERIFICATION.has(verification)) return false;
  const onset = toDate(resource["onsetDateTime"]) ?? (isRecord(resource["onsetPeriod"]) ? toDate(resource["onsetPeriod"]["start"]) : null) ?? toDate(resource["recordedDate"]);
  if (onset !== null && onset > asOf) return false;
  const abatement = toDate(resource["abatementDateTime"]) ?? (isRecord(resource["abatementPeriod"]) ? toDate(resource["abatementPeriod"]["end"]) : null);
  const clinical = statusCode(resource["clinicalStatus"]);
  let active: boolean;
  if (clinical !== undefined && ACTIVE_CLINICAL.has(clinical)) active = true;
  else if (clinical !== undefined) active = abatement !== null && abatement > asOf;
  else active = abatement === null || abatement > asOf;

  const unconfirmed = verification !== undefined && UNCONFIRMED_VERIFICATION.has(verification);
  if (unconfirmed) active = false;

  let used = false;
  for (const coding of codings(resource["code"])) {
    const system = str(coding["system"]);
    const code = str(coding["code"]);
    if (system === undefined || code === undefined || !CODE_RE.test(code) || !/^[\x21-\x7e]{1,200}$/.test(system)) continue;
    used = true;
    const key = `${system}|${code}`;
    const seen = out.get(key);
    if (seen === undefined) {
      const entry: ProfileCondition = { system, code, display: cleanText(coding["display"]) || code, onset, abatement: active ? null : abatement, active };
      out.set(key, unconfirmed ? { ...entry, unconfirmed: true } : entry);
      continue;
    }
    const mergedActive = seen.active || active;
    const earliest = seen.onset === null ? onset : onset === null ? seen.onset : onset < seen.onset ? onset : seen.onset;
    const latestAbatement = seen.abatement === null ? abatement : abatement === null ? seen.abatement : abatement > seen.abatement ? abatement : seen.abatement;
    // One confirmed record of the code makes the merged entry confirmed.
    const { unconfirmed: _seenUnconfirmed, ...rest } = seen;
    const merged: ProfileCondition = { ...rest, onset: earliest, active: mergedActive, abatement: mergedActive ? null : latestAbatement };
    out.set(key, seen.unconfirmed === true && unconfirmed ? { ...merged, unconfirmed: true } : merged);
  }
  return used;
}

function readValue(holder: Json): { value: number | string; unit: string | null } | null {
  const quantity = holder["valueQuantity"];
  if (isRecord(quantity)) {
    const value = quantity["value"];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const code = str(quantity["code"]);
    const unit = quantity["system"] === SYSTEMS.ucum && code !== undefined ? code : (str(quantity["unit"]) ?? code);
    return { value, unit: unit === undefined ? null : cleanText(unit).slice(0, 40) || null };
  }
  const concept = holder["valueCodeableConcept"];
  if (isRecord(concept)) {
    // Coded result: the coding's display, else its code; valueCodeableConcept.text is free text and dropped.
    const first = codings(concept)[0];
    const code = str(first?.["code"]);
    const text = cleanText(first?.["display"]) || (code !== undefined && CODE_RE.test(code) ? code : "");
    return text === "" ? null : { value: text, unit: null };
  }
  // valueString is never kept: questionnaires such as PRAPARE (LOINC 93025-5) put the
  // patient's address and other identifying free text there.
  return null;
}

function keepLatest(out: Map<string, ProfileObservation>, code: string, next: ProfileObservation): void {
  const seen = out.get(code);
  // Same date: the later entry in the bundle wins, so the result is deterministic.
  if (seen === undefined || next.date >= seen.date) out.set(code, next);
}

function readObservation(resource: Json, asOf: string, out: Map<string, ProfileObservation>): boolean {
  const status = str(resource["status"]);
  if (status !== undefined && SKIPPED_OBSERVATION_STATUS.has(status)) return false;
  const date =
    toDate(resource["effectiveDateTime"]) ??
    (isRecord(resource["effectivePeriod"]) ? toDate(resource["effectivePeriod"]["start"]) : null) ??
    toDate(resource["effectiveInstant"]) ??
    toDate(resource["issued"]);
  if (date === null || date > asOf) return false;
  let used = false;
  const own = readValue(resource);
  if (own !== null) {
    for (const { code, display } of codesOf(resource["code"], SYSTEMS.loinc, LOINC_RE)) {
      keepLatest(out, code, { ...own, date, display });
      used = true;
    }
  }
  for (const component of records(resource["component"])) {
    const value = readValue(component);
    if (value === null) continue;
    for (const { code, display } of codesOf(component["code"], SYSTEMS.loinc, LOINC_RE)) {
      keepLatest(out, code, { ...value, date, display });
      used = true;
    }
  }
  return used;
}

function medicationConcept(resource: Json, byRef: Map<string, Json>): unknown {
  if ("medicationCodeableConcept" in resource) return resource["medicationCodeableConcept"];
  const ref = isRecord(resource["medicationReference"]) ? str(resource["medicationReference"]["reference"]) : undefined;
  if (ref === undefined) return undefined;
  if (ref.startsWith("#")) {
    const contained = records(resource["contained"]).find((r) => r["resourceType"] === "Medication" && `#${str(r["id"]) ?? ""}` === ref);
    return contained?.["code"];
  }
  return byRef.get(ref)?.["code"];
}

function readMedication(resource: Json, asOf: string, out: Map<string, ProfileMedication>, byRef: Map<string, Json>): boolean {
  const authoredOn = toDate(resource["authoredOn"]);
  if (authoredOn !== null && authoredOn > asOf) return false;
  const codes = codesOf(medicationConcept(resource, byRef), SYSTEMS.rxnorm, RXNORM_RE);
  if (codes.length === 0) return false;
  if (resource["status"] !== "active") return true;
  for (const { code, display } of codes) {
    const seen = out.get(code);
    if (seen === undefined || (authoredOn !== null && (seen.authoredOn === null || authoredOn > seen.authoredOn))) {
      out.set(code, { rxnorm: code, display, status: "active", authoredOn });
    }
  }
  return true;
}
