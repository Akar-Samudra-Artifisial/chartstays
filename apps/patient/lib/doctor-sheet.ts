// The printable doctor sheet: a summary of the patient's strong and possible matches to take to a
// doctor. Built in this browser from a fresh evaluation every time (never from an older run, which
// may predate a node load) and never sent anywhere. Text that came from a trial node goes through
// the Agent Firewall's neutralizer and is rendered as plain text; the only links are each
// study's ClinicalTrials.gov page.
import type { CriterionStatus, Verdict } from "@chartstays/matcher";
import type { PatientProfile } from "@chartstays/fhir-profile";
import { neutralizeText } from "./firewall-rules.ts";
import { criteriaScope, summarizeProfile, type ProfileSummary } from "./profile-summary.ts";
import type { MatchRun, TrialSession } from "./trial-session.ts";

export const SHEET_DISCLAIMER =
  "Pre-screening information only, not medical advice. It was produced by software from the patient's own record and the studies' published criteria. Only the study team can decide eligibility.";

const MAX_TITLE = 300;
const MAX_LABEL = 400;
const MAX_REASON = 300;
const CTGOV = /^https:\/\/clinicaltrials\.gov\/study\/NCT\d{8}$/;
/** A snapshot date from a node: an ISO date, optionally with a UTC time; anything else is not shown. */
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z)?$/;

/** The node's `retrieved` value if it is an ISO date (time dropped), else "unknown". */
export function snapshotDate(value: unknown): string {
  return typeof value === "string" && ISO_DATE.test(value) ? value.slice(0, 10) : "unknown";
}

export interface SheetCriterion {
  type: "inclusion" | "exclusion";
  status: CriterionStatus;
  label: string;
  reason: string;
}

export interface SheetStudy {
  nct_id: string;
  title: string;
  verdict: Exclude<Verdict, "not_eligible">;
  node: string;
  /** ClinicalTrials.gov page; null when the node gave another address (not linked). */
  ctgovUrl: string | null;
  retrieved: string;
  counts: Record<CriterionStatus, number>;
  /** Coded criteria with the matcher's reason. */
  criteria: SheetCriterion[];
  /** Free-text criteria the matcher cannot check: for the doctor and study team. */
  freeText: { type: "inclusion" | "exclusion"; label: string }[];
}

export interface DoctorSheetModel {
  generatedAt: string;
  asOf: string;
  profile: { ageBand: string | null; sex: string; conditions: string[]; labs: string[]; medications: string[] };
  studies: SheetStudy[];
  /** Studies matched that did not fit on a coded criterion. */
  notEligible: number;
  notIncluded: { node: string; origin: string; reason: string }[];
  /** Distinct ClinicalTrials.gov snapshot dates of the listed studies. */
  snapshots: string[];
  disclaimer: string;
}

function clean(value: string, max: number, origin: string): string {
  return neutralizeText(value, max, origin).replace(/\s+/g, " ").trim();
}

function profileLines(summary: ProfileSummary): DoctorSheetModel["profile"] {
  return {
    ageBand: summary.ageBand,
    sex: summary.sex,
    conditions: summary.conditions.map((c) => `${c.display} (SNOMED CT ${c.code})`),
    labs: summary.labs.map((l) => `${l.name}: ${l.value}${l.unit === null ? "" : ` ${l.unit}`} (${l.month})`),
    medications: summary.medications.map((m) => `${m.display} (RxNorm ${m.rxnorm})`),
  };
}

/** The sheet for one run; `summary` is the profile summary scoped to the listed studies. */
export function buildDoctorSheetModel(run: MatchRun, summary: ProfileSummary, now: Date = new Date()): DoctorSheetModel {
  const studies: SheetStudy[] = [];
  for (const row of run.rows) {
    if (row.verdict === "not_eligible") continue;
    const from = row.node.origin;
    studies.push({
      nct_id: row.nct_id,
      title: clean(row.title, MAX_TITLE, from),
      verdict: row.verdict,
      node: clean(row.node.name, 120, from),
      ctgovUrl: CTGOV.test(row.ctgovUrl) ? row.ctgovUrl : null,
      retrieved: snapshotDate(row.retrieved),
      counts: row.counts,
      criteria: row.criteria.filter((c) => c.kind !== "free_text").map((c) => ({ type: c.type, status: c.status, label: clean(c.label, MAX_LABEL, from), reason: clean(c.reason, MAX_REASON, from) })),
      freeText: row.criteria.filter((c) => c.kind === "free_text").map((c) => ({ type: c.type, label: clean(c.label, MAX_LABEL, from) })),
    });
  }
  return {
    generatedAt: now.toISOString(),
    asOf: run.asOf,
    profile: profileLines(summary),
    studies,
    notEligible: run.rows.length - studies.length,
    notIncluded: run.missing.map((m) => ({ node: clean(m.name, 120, m.origin), origin: m.origin, reason: clean(m.message, MAX_REASON, m.origin) })),
    snapshots: [...new Set(studies.map((s) => s.retrieved).filter((d) => d !== "unknown"))].sort(),
    disclaimer: SHEET_DISCLAIMER,
  };
}

/** Evaluates again over every loaded node, then builds the sheet. */
export async function freshDoctorSheet(session: TrialSession, profile: () => Promise<PatientProfile | null>, now?: Date): Promise<DoctorSheetModel> {
  const run = await session.evaluate();
  const p = await profile();
  if (p === null) throw new Error("No health record is imported yet.");
  const docs = run.rows.filter((r) => r.verdict !== "not_eligible").flatMap((r) => session.criteriaFor(r.nct_id) ?? []);
  return buildDoctorSheetModel(run, summarizeProfile(p, criteriaScope(docs)), now);
}

const STATUS: Record<CriterionStatus, string> = { met: "MET", not_met: "NOT MET", unknown: "UNKNOWN" };

/** Plain-text version, for download. */
export function doctorSheetText(model: DoctorSheetModel): string {
  const p = model.profile;
  const lines = [
    "ChartStays pre-screening summary for my doctor",
    `Record as of ${model.asOf}; prepared ${model.generatedAt.slice(0, 10)} in my browser.`,
    model.disclaimer,
    "",
    "PATIENT SUMMARY (only the record items these studies refer to)",
    `Age range: ${p.ageBand ?? "unknown"} | Sex: ${p.sex}`,
    `Diagnoses: ${p.conditions.join("; ") || "none relevant"}`,
    `Labs: ${p.labs.join("; ") || "none relevant"}`,
    `Medications: ${p.medications.join("; ") || "none relevant"}`,
    "",
  ];
  if (model.studies.length === 0) lines.push("No study looked like a strong or possible match on the coded criteria.", "");
  for (const s of model.studies) {
    lines.push(
      `${s.nct_id}: ${s.title}`,
      `  Result: ${s.verdict === "strong_match" ? "strong match" : "possible match"} (met ${s.counts.met}, unknown ${s.counts.unknown}, not met ${s.counts.not_met})`,
      `  Source: ${s.ctgovUrl ?? "ClinicalTrials.gov"} (snapshot ${s.retrieved}) via ${s.node}`,
    );
    for (const c of s.criteria) lines.push(`  - ${STATUS[c.status]} [${c.type}] ${c.label}: ${c.reason}`);
    if (s.freeText.length > 0) {
      lines.push("  To check with the doctor or study team:");
      for (const f of s.freeText) lines.push(`  - [${f.type}] ${f.label}`);
    }
    lines.push("");
  }
  if (model.notEligible > 0) lines.push(`${model.notEligible} other studies did not fit on a coded criterion.`);
  for (const m of model.notIncluded) lines.push(`Not included: ${m.node} (${m.origin}): ${m.reason}`);
  lines.push(`Sources: ClinicalTrials.gov records, snapshot ${model.snapshots.join(", ") || "n/a"}.`);
  return lines.join("\n");
}
