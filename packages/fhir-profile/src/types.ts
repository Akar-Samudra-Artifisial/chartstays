// The ChartStays patient profile: the only patient data the app keeps after an import.
// It holds no name, address, identifier, telephone or exact birth date; age is computed
// at `asOf` and the raw bundle is discarded.

export const PROFILE_SCHEMA = "chartstays.profile/1";

export type ProfileSex = "female" | "male" | "other" | "unknown";

export interface ProfileCondition {
  /** Coding system URI, e.g. http://snomed.info/sct. */
  system: string;
  code: string;
  display: string;
  /** Earliest onset of this code (YYYY-MM-DD) or null. */
  onset: string | null;
  /** Latest abatement (YYYY-MM-DD) when the condition is no longer active, else null. */
  abatement: string | null;
  /** Active (or recurring/relapsed) on `asOf`; never true for an unconfirmed condition. */
  active: boolean;
  /** Set when every record of this code is unconfirmed, provisional or differential. */
  unconfirmed?: true;
}

export interface ProfileObservation {
  /** Numeric result, or the display text of a coded result (free-text results are dropped). */
  value: number | string;
  /** UCUM unit code (or the unit text when no UCUM code is given); null for coded results. */
  unit: string | null;
  /** Effective date (YYYY-MM-DD). */
  date: string;
  display: string;
}

export interface ProfileMedication {
  rxnorm: string;
  display: string;
  status: "active";
  /** YYYY-MM-DD or null. */
  authoredOn: string | null;
}

export interface PatientProfile {
  schema: typeof PROFILE_SCHEMA;
  /** Date (YYYY-MM-DD) the profile describes; age and "active" are evaluated on it. */
  asOf: string;
  /** Whole years on `asOf` (or at death); null without a usable birth date. */
  age: number | null;
  sex: ProfileSex;
  deceased: boolean;
  /** One entry per coding system + code, sorted by system then code. */
  conditions: ProfileCondition[];
  /** Latest result per LOINC code (components such as blood pressure included). */
  observations: Record<string, ProfileObservation>;
  /** Active medication requests, one entry per RxNorm code, sorted by code. */
  medications: ProfileMedication[];
  /** What was read, for display and debugging; holds no patient data. */
  source: {
    format: "FHIR R4 Bundle";
    resources: Record<string, number>;
    /** Resources ignored: unsupported type, entered in error, dated after asOf, unusable code. */
    skipped: number;
  };
}

const SEXES: readonly unknown[] = ["female", "male", "other", "unknown"];

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check for a stored profile (e.g. read back from IndexedDB): the current schema
 * tag and the basic field types. Anything else should be treated as no profile.
 */
export function isPatientProfile(value: unknown): value is PatientProfile {
  if (!isRecordLike(value) || value["schema"] !== PROFILE_SCHEMA) return false;
  const age = value["age"];
  return (
    typeof value["asOf"] === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value["asOf"]) &&
    (age === null || (typeof age === "number" && Number.isFinite(age))) &&
    SEXES.includes(value["sex"]) &&
    typeof value["deceased"] === "boolean" &&
    Array.isArray(value["conditions"]) &&
    value["conditions"].every((c) => isRecordLike(c) && typeof c["code"] === "string" && typeof c["display"] === "string" && typeof c["active"] === "boolean") &&
    isRecordLike(value["observations"]) &&
    Array.isArray(value["medications"]) &&
    value["medications"].every((m) => isRecordLike(m) && typeof m["rxnorm"] === "string" && typeof m["display"] === "string") &&
    isRecordLike(value["source"])
  );
}

export interface ParseOptions {
  /** Evaluation date. Data dated after it is ignored. */
  asOf: Date;
}
