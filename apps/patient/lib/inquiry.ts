// prepareInquiry: a message the patient can send to a study team themselves, through the contact
// details on the study's ClinicalTrials.gov page. It is written in this browser and only copied
// or downloaded; ChartStays never sends it. By default it holds no health data (the study id, its
// ClinicalTrials.gov link and a generic question). Each field from the record is opt-in, limited
// to what the study's curated `requested_fields_for_inquiry` asks for, and the patient sees the
// full text with the health-data scanner's highlights before anything is produced. The agent only
// gets metadata back (field names, counts), never the draft.
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import type { PatientProfile } from "@chartstays/fhir-profile";
import { neutralizeText } from "./firewall-rules.ts";
import { criteriaScope, summarizeProfile } from "./profile-summary.ts";
import type { MatchRow, TrialSession } from "./trial-session.ts";
import type { TrustLog } from "./trust-log.ts";

export const NCT_RE = /^NCT\d{8}$/;
const MAX_TITLE = 200;

export interface InquiryField {
  /** "title", "result", "age", "sex", "conditions", "medications" or "labs:<LOINC>". */
  key: string;
  label: string;
  /** The line added to the draft when the patient opts in. */
  line: string;
}

export interface InquiryStudy {
  nct_id: string;
  title: string;
  /** Built from a valid nct_id, never taken from the node; null when the id is not an NCT id. */
  ctgovUrl: string | null;
  origin: string;
  verdict: MatchRow["verdict"];
  counts: MatchRow["counts"];
}

/** The study's ClinicalTrials.gov page, or null when `nctId` is not an NCT id. */
export function ctgovUrlFor(nctId: string): string | null {
  return NCT_RE.test(nctId) ? `https://clinicaltrials.gov/study/${nctId}` : null;
}

export function studyOf(row: MatchRow): InquiryStudy {
  return { nct_id: row.nct_id, title: row.title, ctgovUrl: ctgovUrlFor(row.nct_id), origin: row.node.origin, verdict: row.verdict, counts: row.counts };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The opt-in fields for one study: its title and the pre-screening result (both can reveal the
 * condition), then the record items the study asks for, from the minimal profile summary.
 */
export function inquiryFields(study: InquiryStudy, doc: CriteriaDocument | null, profile: PatientProfile): InquiryField[] {
  // Node text: through the firewall's neutralizer, as plain text (it is rendered as text only).
  const title = oneLine(neutralizeText(study.title, MAX_TITLE, study.origin));
  const fields: InquiryField[] = [
    { key: "title", label: "Study title", line: `Study title: ${title}` },
    {
      key: "result",
      label: "My pre-screening result",
      line: `A pre-screening tool suggested this study is a ${study.verdict === "strong_match" ? "strong" : "possible"} match for me (${study.counts.met} criteria met, ${study.counts.unknown} to confirm).`,
    },
  ];
  if (doc === null) return fields;
  const requested = doc.requested_fields_for_inquiry;
  const requestedLabs = requested.filter((f) => f.startsWith("labs:")).map((f) => f.slice(5));
  const scope = criteriaScope([doc]);
  const summary = summarizeProfile(profile, { ...scope, loinc: new Set([...scope.loinc, ...requestedLabs]) });
  for (const key of requested) {
    if (key === "age" && summary.ageBand !== null) fields.push({ key, label: "Age range", line: `Age range: ${summary.ageBand}` });
    else if (key === "sex" && summary.sex !== "unknown") fields.push({ key, label: "Sex", line: `Sex: ${summary.sex}` });
    else if (key === "conditions" && summary.conditions.length > 0) {
      fields.push({ key, label: "Diagnoses this study asks about", line: `Diagnoses: ${summary.conditions.map((c) => c.display.replace(/\s*\((disorder|disease)\)$/, "")).join("; ")}` });
    } else if (key === "medications" && summary.medications.length > 0) {
      fields.push({ key, label: "Medications this study asks about", line: `Medications: ${summary.medications.map((m) => m.display).join("; ")}` });
    } else if (key.startsWith("labs:")) {
      const lab = summary.labs.find((l) => l.loinc === key.slice(5));
      if (lab !== undefined) fields.push({ key, label: `Lab: ${lab.name}`, line: `${lab.name}: ${lab.value}${lab.unit === null ? "" : ` ${lab.unit}`} (${lab.month})` });
    }
  }
  return fields;
}

/** The draft: no health data unless the patient chose fields. */
export function inquiryDraft(study: InquiryStudy, fields: readonly InquiryField[], chosen: ReadonlySet<string>): string {
  const shared = fields.filter((f) => chosen.has(f.key));
  const lines = [
    `Subject: Question about study ${study.nct_id}`,
    "",
    "Hello,",
    "",
    `I found study ${study.nct_id} on ClinicalTrials.gov${study.ctgovUrl === null ? "" : ` (${study.ctgovUrl})`} and would like to ask whether I could take part, and how screening works.`,
  ];
  if (shared.length > 0) lines.push("", "Information I chose to share:", ...shared.map((f) => `- ${f.line}`));
  lines.push("", "Could you tell me the next steps? I can give more details to the study team directly.", "", "Thank you.");
  return lines.join("\n");
}

export interface InquiryApproval {
  nct_id: string;
  /** Names of the fields the patient chose. */
  fields: string[];
  /** Health-data spans the scanner found in the draft. */
  phiFields: number;
  draft: string;
}

/** Opens the app's inquiry dialog; resolves with the approved draft, or null when cancelled. */
export type InquiryOpener = (request: { study: InquiryStudy; via: "agent" | "user" }) => Promise<InquiryApproval | null>;

/** What the action's execute gets: field names and counts, never the draft. */
export type InquiryReceipt = Omit<InquiryApproval, "draft">;

/**
 * How long an approval waits for the action's execute, which the runtime runs right after the
 * confirmation. An approval whose execute never ran (timeout, cancelled run) expires.
 */
export const APPROVAL_TTL_MS = 60_000;

/** Between the agent's tool call, the app's dialog and the action's execute. */
export class InquiryDesk {
  #opener: InquiryOpener | null = null;
  #approved = new Map<string, { receipt: InquiryReceipt; at: number }>();
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  setOpener(opener: InquiryOpener | null): void {
    this.#opener = opener;
  }

  async request(study: InquiryStudy, via: "agent" | "user"): Promise<InquiryApproval | null> {
    // A new request replaces any approval for the same study that was never taken.
    this.#approved.delete(study.nct_id);
    if (this.#opener === null) return null;
    const approval = await this.#opener({ study, via });
    if (approval !== null && via === "agent") {
      this.#approved.set(approval.nct_id, { receipt: { nct_id: approval.nct_id, fields: approval.fields, phiFields: approval.phiFields }, at: this.#now() });
    }
    return approval;
  }

  /** The approval for `nctId`, once, unless it expired. */
  take(nctId: string): InquiryReceipt | undefined {
    const entry = this.#approved.get(nctId);
    this.#approved.delete(nctId);
    if (entry === undefined || this.#now() - entry.at > APPROVAL_TTL_MS) return undefined;
    return entry.receipt;
  }

  /** Forget every approval ("Delete my data"). */
  clear(): void {
    this.#approved.clear();
  }

  /** How many approvals are waiting (for tests). */
  get waiting(): number {
    return this.#approved.size;
  }
}

/** A strong or possible match in the latest run, or null. */
export function candidate(session: TrialSession, nctId: string): MatchRow | null {
  const row = session.lastRun()?.rows.find((r) => r.nct_id === nctId);
  return row !== undefined && row.verdict !== "not_eligible" ? row : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The runtime's confirmation hook for irreversible website actions (engine.onActionConfirm).
 * Only one prepareInquiry call for a strong or possible match of the latest run opens the
 * dialog; anything else is declined without asking and logged.
 */
export function createActionGate(deps: { desk: InquiryDesk; session: TrialSession; log: TrustLog; origin: string }): (items: unknown) => Promise<boolean> {
  return async (items) => {
    const refuse = (nct: string, detail: string): boolean => {
      deps.log.record({ type: "inquiry", nct_id: nct, via: "agent", action: "refused", detail });
      return false;
    };
    if (!Array.isArray(items) || items.length !== 1 || !isPlainObject(items[0])) return refuse("(none)", "only one prepareInquiry call at a time is accepted");
    const item = items[0];
    if (item["action"] !== "prepareInquiry") return refuse("(none)", `the action ${JSON.stringify(String(item["action"]).slice(0, 60))} cannot be confirmed here`);
    if (item["origin"] !== deps.origin) return refuse("(none)", "the action is not this site's");
    const args = isPlainObject(item["arguments"]) ? item["arguments"] : {};
    const nct = typeof args["nct_id"] === "string" ? args["nct_id"].trim() : "";
    if (!NCT_RE.test(nct) || Object.keys(args).length !== 1) return refuse("(invalid)", "nct_id must be one NCT id (NCT followed by 8 digits) from the match results");
    const row = candidate(deps.session, nct);
    if (row === null) return refuse(nct, "not a strong or possible match in the latest results");
    return (await deps.desk.request(studyOf(row), "agent")) !== null;
  };
}

/** Install the gate on a booted engine and make it read-only (like lockConsentGate). */
export function lockActionGate(engine: object, gate: (items: unknown) => Promise<boolean>): void {
  Object.defineProperty(engine, "onActionConfirm", { value: gate, writable: false, configurable: false, enumerable: true });
  if ((engine as { onActionConfirm?: unknown }).onActionConfirm !== gate) throw new Error("Could not install the action confirmation gate.");
}
