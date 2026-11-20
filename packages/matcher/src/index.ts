// Deterministic pre-screening of a patient profile against criteria.json documents.
// Every result carries the evidence it used and a fixed English reason; no LLM involved.
// Semantics: README "Matching semantics" and "Verdicts".

import type {
  AgeCriterion,
  ConditionCriterion,
  CriteriaDocument,
  CriterionType,
  FreeTextCriterion,
  GroupLogic,
  LabCriterion,
  LabOp,
  MedicationCriterion,
  SexCriterion,
  StructuredCriterion,
} from "@chartstays/criteria-schema";
import type { PatientProfile } from "@chartstays/fhir-profile";
import { convert, unitInfo } from "./units.ts";

export { convert, unitInfo } from "./units.ts";

export type CriterionStatus = "met" | "not_met" | "unknown";
/**
 * strong_match: every coded criterion is decided in favour; only free-text items remain.
 * possible_match: nothing disqualifies, but at least one coded criterion is unknown.
 * not_eligible: a coded inclusion is not met or a coded exclusion applies.
 */
export type Verdict = "strong_match" | "possible_match" | "not_eligible";

export interface Evidence {
  source: "age" | "sex" | "condition" | "observation" | "medication";
  code?: string;
  system?: string;
  display?: string;
  value?: number | string;
  unit?: string | null;
  date?: string | null;
  active?: boolean;
}

export interface CriterionResult {
  id: string;
  type: CriterionType;
  kind: StructuredCriterion["kind"] | "free_text";
  label: string;
  status: CriterionStatus;
  reason: string;
  evidence: Evidence[];
  group?: string;
  group_logic?: GroupLogic;
}

export interface GroupResult {
  group: string;
  type: CriterionType;
  logic: GroupLogic;
  status: CriterionStatus;
  members: string[];
}

export interface StudyResult {
  nct_id: string;
  title: string;
  verdict: Verdict;
  counts: Record<CriterionStatus, number>;
  /** Unknown criteria: structured (missing or stale data) and free text (items to confirm with a doctor). */
  unknowns: { structured: number; free_text: number };
  criteria: CriterionResult[];
  groups: GroupResult[];
  /** The criteria that decided the verdict, as short sentences. */
  reasons: string[];
}

export interface MatchOptions {
  /** Lab results older than this many days before the profile's asOf are unknown. Default 365. */
  labMaxAgeDays?: number;
}

export const DEFAULT_LAB_MAX_AGE_DAYS = 365;

const HISTORY_RE = /\b(history of|prior|previous(?:ly)?)\b/i;
// A negation up to two words before the history phrase: "no prior", "without any previous", "never had a history of".
const NEGATED_HISTORY_RE = /\b(?:no|without|not|never)(?:\s+[a-z]+){0,2}?\s+(?:history of|prior|previous(?:ly)?)\b/i;
export const ABSENT_EXCLUSION = "No recorded exclusion applies (based on the imported record; absence is not confirmed).";
const SNOMED = "http://snomed.info/sct";
const OP_TEXT: Record<Exclude<LabOp, "between">, string> = { lt: "below", lte: "at most", gt: "above", gte: "at least" };

const result = (status: CriterionStatus, reason: string, evidence: Evidence[] = []) => ({ status, reason, evidence });
type Outcome = ReturnType<typeof result>;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function withUnit(value: number, unit: string): string {
  return unit === "%" ? `${fmt(value)}%` : `${fmt(value)} ${unit}`;
}

function evaluateAge(profile: PatientProfile, c: AgeCriterion): Outcome {
  if (profile.age === null) return result("unknown", "Age is not known (no full birth date in the record).");
  const evidence: Evidence[] = [{ source: "age", value: profile.age, unit: "years", date: profile.asOf }];
  if (c.min !== null && profile.age < c.min) return result("not_met", `Age ${profile.age} is below the minimum of ${c.min}.`, evidence);
  if (c.max !== null && profile.age > c.max) return result("not_met", `Age ${profile.age} is above the maximum of ${c.max}.`, evidence);
  const range = c.min !== null && c.max !== null ? `within ${c.min} to ${c.max}` : c.min !== null ? `at least ${c.min}` : c.max !== null ? `at most ${c.max}` : "accepted (no limit)";
  return result("met", `Age ${profile.age} is ${range}.`, evidence);
}

function evaluateSex(profile: PatientProfile, c: SexCriterion): Outcome {
  if (profile.sex !== "female" && profile.sex !== "male") return result("unknown", `Sex is recorded as ${profile.sex}.`);
  const evidence: Evidence[] = [{ source: "sex", value: profile.sex }];
  return profile.sex === c.sex
    ? result("met", `Sex is ${profile.sex}.`, evidence)
    : result("not_met", `Sex is ${profile.sex}; the criterion requires ${c.sex}.`, evidence);
}

/** True when the criterion label itself counts past conditions ("history of", "prior", "previous"), unless negated ("no prior ..."). */
export function includesHistory(label: string): boolean {
  return HISTORY_RE.test(label) && !NEGATED_HISTORY_RE.test(label);
}

/** Most recent onset first; conditions without an onset last. */
function byLatestOnset<T extends { onset: string | null }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (b.onset ?? "").localeCompare(a.onset ?? ""));
}

function evaluateCondition(profile: PatientProfile, c: ConditionCriterion): Outcome {
  const codes = new Set(c.codes.snomed);
  const found = byLatestOnset(profile.conditions.filter((x) => x.system === SNOMED && codes.has(x.code)));
  const evidence: Evidence[] = found.map((x) => ({ source: "condition", system: x.system, code: x.code, display: x.display, date: x.onset, active: x.active }));
  if (found.length === 0) {
    // Absence is only evidence for the area's main condition (primary) and for exclusions.
    if (c.type === "exclusion") return result("not_met", ABSENT_EXCLUSION);
    if (c.primary === true) return result("not_met", `No matching condition in the record (${c.label}).`);
    return result("unknown", `${c.label} is not recorded; the imported record may be incomplete.`);
  }
  const active = found.filter((x) => x.active);
  if (active.length > 0) {
    const latest = active[0]!;
    return result("met", `Active condition: ${latest.display}${latest.onset ? ` since ${latest.onset}` : ""}.`, evidence);
  }
  const confirmed = found.filter((x) => x.unconfirmed !== true);
  if (confirmed.length === 0) {
    return result("unknown", `${found[0]!.display} is recorded as unconfirmed or provisional; the study team has to check it.`, evidence);
  }
  const latest = confirmed[0]!;
  if (includesHistory(c.label)) {
    return result("met", `Past condition: ${latest.display}${latest.abatement ? `, resolved ${latest.abatement}` : ""}; the criterion includes history.`, evidence);
  }
  return result("not_met", `${latest.display} is recorded as resolved${latest.abatement ? ` on ${latest.abatement}` : ""}, not active.`, evidence);
}

function evaluateMedication(profile: PatientProfile, c: MedicationCriterion): Outcome {
  const codes = new Set(c.rxnorm);
  const found = profile.medications.filter((m) => codes.has(m.rxnorm));
  if (found.length === 0) {
    if (c.type === "exclusion") return result("not_met", ABSENT_EXCLUSION);
    return result("unknown", `No active prescription matching ${c.label.toLowerCase()} in the record; the imported record may be incomplete.`);
  }
  const evidence: Evidence[] = found.map((m) => ({ source: "medication", code: m.rxnorm, display: m.display, date: m.authoredOn, active: true }));
  return result("met", `Active prescription: ${found[0]!.display}.`, evidence);
}

function compareLab(op: LabOp, value: number, target: number | [number, number]): boolean {
  if (op === "between") {
    const [low, high] = target as [number, number];
    return value >= low && value <= high;
  }
  const t = target as number;
  return op === "lt" ? value < t : op === "lte" ? value <= t : op === "gt" ? value > t : value >= t;
}

function labTargetText(c: LabCriterion): string {
  if (c.op === "between") {
    const [low, high] = c.value as [number, number];
    return `between ${fmt(low)} and ${withUnit(high, c.unit)}`;
  }
  return `${OP_TEXT[c.op]} ${withUnit(c.value as number, c.unit)}`;
}

function evaluateLab(profile: PatientProfile, c: LabCriterion, maxAgeDays: number): Outcome {
  const obs = profile.observations[c.loinc];
  if (obs === undefined) return result("unknown", `No result for ${c.label.toLowerCase()} (LOINC ${c.loinc}) in the record.`);
  const evidence: Evidence[] = [{ source: "observation", code: c.loinc, display: obs.display, value: obs.value, unit: obs.unit, date: obs.date }];
  if (typeof obs.value !== "number") return result("unknown", `The latest ${obs.display} result is not numeric.`, evidence);
  const age = daysBetween(obs.date, profile.asOf);
  if (age > maxAgeDays) {
    return result("unknown", `The latest ${obs.display} result is from ${obs.date}, older than ${maxAgeDays} days.`, evidence);
  }
  const conv = convert(obs.value, obs.unit, c.unit);
  if (!conv.ok) {
    const why = conv.reason === "unknown_unit" ? `unit ${conv.unit} is not recognised` : `unit ${conv.unit} cannot be converted to ${c.unit}`;
    return result("unknown", `The latest ${obs.display} result is ${fmt(obs.value)} ${obs.unit ?? ""}`.trimEnd() + `, but ${why}.`, evidence);
  }
  const unit = unitInfo(c.unit)?.canonical ?? c.unit;
  const shown = conv.converted ? `${withUnit(obs.value, obs.unit ?? "")} (${withUnit(conv.value, unit)})` : withUnit(obs.value, unit);
  const ok = compareLab(c.op, conv.value, c.value);
  return result(ok ? "met" : "not_met", `Latest ${obs.display} is ${shown} on ${obs.date}, ${ok ? "" : "not "}${labTargetText(c)}.`, evidence);
}

function evaluateStructured(profile: PatientProfile, c: StructuredCriterion, opts: Required<MatchOptions>): CriterionResult {
  let outcome: Outcome;
  switch (c.kind) {
    case "age":
      outcome = evaluateAge(profile, c);
      break;
    case "sex":
      outcome = evaluateSex(profile, c);
      break;
    case "condition":
      outcome = evaluateCondition(profile, c);
      break;
    case "lab":
      outcome = evaluateLab(profile, c, opts.labMaxAgeDays);
      break;
    case "medication":
      outcome = evaluateMedication(profile, c);
      break;
    default:
      outcome = result("unknown", "Unsupported criterion kind.");
  }
  const base: CriterionResult = { id: c.id, type: c.type, kind: c.kind, label: c.label, ...outcome };
  return c.group !== undefined && c.group_logic !== undefined ? { ...base, group: c.group, group_logic: c.group_logic } : base;
}

function evaluateFreeText(c: FreeTextCriterion): CriterionResult {
  return {
    id: c.id,
    type: c.type,
    kind: "free_text",
    label: c.text,
    status: "unknown",
    reason: "Free-text criterion: the study team has to check it.",
    evidence: [],
  };
}

/** Combine group members: "any" is met by one met member, "all" needs every member met. */
export function combineGroup(logic: GroupLogic, statuses: CriterionStatus[]): CriterionStatus {
  if (logic === "any") {
    if (statuses.includes("met")) return "met";
    return statuses.includes("unknown") ? "unknown" : "not_met";
  }
  if (statuses.includes("not_met")) return "not_met";
  return statuses.includes("unknown") ? "unknown" : "met";
}

interface Unit {
  type: CriterionType;
  status: CriterionStatus;
  label: string;
  reasons: string[];
  freeText: boolean;
}

/** Evaluate one study for one profile. */
export function evaluateStudy(profile: PatientProfile, criteria: CriteriaDocument, options: MatchOptions = {}): StudyResult {
  const opts: Required<MatchOptions> = { labMaxAgeDays: options.labMaxAgeDays ?? DEFAULT_LAB_MAX_AGE_DAYS };
  if (!Number.isFinite(opts.labMaxAgeDays) || opts.labMaxAgeDays < 0) throw new RangeError("labMaxAgeDays must be a non-negative number");

  const structured = criteria.structured.map((c) => evaluateStructured(profile, c, opts));
  const freeText = criteria.free_text.map(evaluateFreeText);
  const all = [...structured, ...freeText];

  // Decision units: each ungrouped criterion, and each logic group as one unit.
  const units: Unit[] = [];
  const groups: GroupResult[] = [];
  const grouped = new Map<string, CriterionResult[]>();
  for (const r of all) {
    if (r.group === undefined) {
      units.push({ type: r.type, status: r.status, label: r.label, reasons: [r.reason], freeText: r.kind === "free_text" });
      continue;
    }
    const members = grouped.get(r.group) ?? [];
    members.push(r);
    grouped.set(r.group, members);
  }
  for (const [group, members] of grouped) {
    const first = members[0]!;
    const logic = first.group_logic ?? "all";
    const status = combineGroup(logic, members.map((m) => m.status));
    groups.push({ group, type: first.type, logic, status, members: members.map((m) => m.id) });
    const decisive = members.filter((m) => m.status === status);
    units.push({ type: first.type, status, label: members.map((m) => m.label).join(logic === "any" ? " or " : " and "), reasons: (decisive.length > 0 ? decisive : members).map((m) => m.reason), freeText: false });
  }

  // Free-text criteria are always unknown and never decide the tier; they are the items to confirm.
  const coded = units.filter((u) => !u.freeText);
  const blocking = coded.filter((u) => (u.type === "inclusion" && u.status === "not_met") || (u.type === "exclusion" && u.status === "met"));
  const codedUnknown = coded.filter((u) => u.status === "unknown");
  const verdict: Verdict = blocking.length > 0 ? "not_eligible" : codedUnknown.length > 0 ? "possible_match" : "strong_match";

  const unknowns = {
    structured: structured.filter((r) => r.status === "unknown").length,
    free_text: freeText.length,
  };
  const reasons: string[] = [];
  if (verdict === "not_eligible") {
    for (const u of blocking) reasons.push(...u.reasons.map((r) => `${u.type === "inclusion" ? "Inclusion not met" : "Exclusion applies"}: ${r}`));
  } else {
    if (verdict === "possible_match") {
      for (const u of codedUnknown) reasons.push(`Unknown ${u.type}: ${u.reasons.join(" ")}`);
    } else {
      reasons.push("Every coded inclusion criterion is met and no coded exclusion applies.");
    }
    if (unknowns.free_text > 0) reasons.push(toConfirmText(unknowns.free_text));
  }

  const counts: Record<CriterionStatus, number> = { met: 0, not_met: 0, unknown: 0 };
  for (const r of all) counts[r.status] += 1;

  return { nct_id: criteria.nct_id, title: criteria.title, verdict, counts, unknowns, criteria: all, groups, reasons };
}

/** "N items to confirm with your doctor": free-text criteria the record cannot answer. */
export function toConfirmText(n: number): string {
  return `${n} item${n === 1 ? "" : "s"} to confirm with your doctor.`;
}

const VERDICT_ORDER: Record<Verdict, number> = { strong_match: 0, possible_match: 1, not_eligible: 2 };

/**
 * Evaluate several studies: strong_match, then possible_match, then not_eligible; then fewer
 * structured unknowns; then fewer free-text items; then NCT id.
 */
export function rankStudies(profile: PatientProfile, criteriaList: readonly CriteriaDocument[], options: MatchOptions = {}): StudyResult[] {
  return criteriaList
    .map((doc) => evaluateStudy(profile, doc, options))
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
        a.unknowns.structured - b.unknowns.structured ||
        a.unknowns.free_text - b.unknowns.free_text ||
        (a.nct_id < b.nct_id ? -1 : a.nct_id > b.nct_id ? 1 : 0),
    );
}
