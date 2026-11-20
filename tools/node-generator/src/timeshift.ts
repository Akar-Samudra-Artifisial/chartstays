// Shift every date of a synthetic FHIR bundle by one fixed number of days per patient, so the
// latest clinical date lands on a reference date. Synthea samples are generated once and age;
// shifting keeps the intervals between events (and the patient's age at the latest event).

/** The latest clinical date of every shifted demo patient. */
export const TIMESHIFT_REFERENCE = "2026-11-01";

/** FHIR date, dateTime or instant: YYYY, YYYY-MM, YYYY-MM-DD, optionally with a time. */
const FHIR_DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(T.*)?)?)?$/;
/** Keys of date-typed FHIR elements. Codes (e.g. RxNorm "6809") are never touched. */
const DATE_KEY_RE = /^(?:.*(?:Date|DateTime|Instant)|issued|authoredOn|start|end|date|lastUpdated|recorded|timestamp|created|occurrence)$/;
const BIRTH_KEY = "birthDate";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ShiftResult {
  bundle: Json;
  offsetDays: number;
  /** Latest clinical date before the shift (YYYY-MM-DD). */
  latest: string;
  /** Number of values shifted, birthDate included. */
  shifted: number;
}

function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Days since 1970-01-01 of a YYYY-MM-DD date (UTC). */
export function dayNumber(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid date ${date}`);
  return Math.round(ms / 86_400_000);
}

function fromDayNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD of a FHIR date value (partial dates -> first of the period); null when not a date. */
export function datePart(value: string): string | null {
  const m = FHIR_DATE_RE.exec(value);
  if (m === null) return null;
  return `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}`;
}

/** Shift one FHIR date value by whole days, keeping its precision, time of day and offset. */
export function shiftValue(value: string, days: number): string {
  const m = FHIR_DATE_RE.exec(value);
  if (m === null) throw new Error(`Not a FHIR date: ${value}`);
  const shifted = fromDayNumber(dayNumber(datePart(value)!) + days);
  if (m[2] === undefined) return shifted.slice(0, 4);
  if (m[3] === undefined) return shifted.slice(0, 7);
  return shifted + (m[4] ?? "");
}

function visitDates(node: Json, visit: (key: string, value: string) => string | undefined): Json {
  if (Array.isArray(node)) return node.map((x) => visitDates(x, visit));
  if (!isObject(node)) return node;
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && DATE_KEY_RE.test(key) && FHIR_DATE_RE.test(value)) {
      out[key] = visit(key, value) ?? value;
    } else if (typeof value === "object" && value !== null) {
      out[key] = visitDates(value, visit);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Every date in the bundle as [key, YYYY-MM-DD] pairs, birthDate included. */
export function collectDates(bundle: Json): [string, string][] {
  const found: [string, string][] = [];
  visitDates(bundle, (key, value) => {
    found.push([key, datePart(value)!]);
    return undefined;
  });
  return found;
}

/** Shift every date in the bundle so its latest clinical (non-birth) date equals `reference`. */
export function timeshiftBundle(bundle: Json, reference: string = TIMESHIFT_REFERENCE): ShiftResult {
  const clinical = collectDates(bundle).filter(([key]) => key !== BIRTH_KEY).map(([, date]) => date);
  if (clinical.length === 0) throw new Error("The bundle has no clinical date to anchor the shift");
  const latest = clinical.reduce((a, b) => (b > a ? b : a));
  const offsetDays = dayNumber(reference) - dayNumber(latest);
  let shifted = 0;
  const out = visitDates(bundle, (_key, value) => {
    shifted += 1;
    return shiftValue(value, offsetDays);
  });
  return { bundle: out, offsetDays, latest, shifted };
}

/** Whole years between two YYYY-MM-DD dates. */
export function yearsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}
