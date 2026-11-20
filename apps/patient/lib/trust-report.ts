// The trust panel's model and its JSON export, built from the trust log alone. The log holds no
// patient data (questions are recorded only after the health-data scan passed, blocked text only
// with each detected value replaced by its kind), so neither does the report.
import type { PhiSegment } from "./phi-scan.ts";
import type { TrustEvent } from "./trust-log.ts";

type Of<T extends TrustEvent["type"]> = Extract<TrustEvent, { type: T }>;

export type ConsentStatus = "allowed for this session" | "allowed once" | "denied" | "revoked" | "not asked";

export interface OriginReport {
  origin: string;
  network: string;
  consent: ConsentStatus;
  quarantined: string | null;
  /** Patient fields the scan found in what was sent to this origin (requests and questions). */
  patientFieldsSent: number;
  /** `query`: the censored query string (health-data values replaced by their kind); `queryLength`: its length as sent. */
  requests: { at: number; path: string; query: string | null; queryLength: number; bytes: number | null; result: "ok" | "error"; detail: string | null }[];
  /** Questions that left the browser for the node's assistant (each passed the health-data scan). */
  questions: { at: number; text: string; patientFields: number }[];
  firewall: { at: number; rule: string; direction: string; action: string; reason: string; field: string | null; snippet: string | null; redacted: PhiSegment[] | null }[];
  /** Consent and link decisions the gate or link guard blocked. */
  blocked: { at: number; what: string; reason: string }[];
}

export interface TrustSummary {
  patientFieldsSent: number;
  requests: number;
  blocked: number;
  quarantined: number;
  neutralized: number;
}

export interface TrustReport {
  generatedAt: string;
  summary: TrustSummary;
  origins: OriginReport[];
}

const SENT_DECISIONS = new Set(["allow_once", "allow_session", "remembered"]);

/** The consent gate tags blocks it took from a firewall finding with "[rule]"; those are counted once, as the finding. */
function fromFirewall(event: Of<"consent">): boolean {
  return /\[(?:out|fw|in)\.[a-z-]+\]$/.test(event.detail ?? "");
}

export function trustReport(events: readonly TrustEvent[], quarantined: readonly { origin: string; reason: string }[] = [], now: () => number = Date.now): TrustReport {
  const byOrigin = new Map<string, OriginReport>();
  const get = (origin: string): OriginReport => {
    let report = byOrigin.get(origin);
    if (report === undefined) {
      report = { origin, network: "", consent: "not asked", quarantined: null, patientFieldsSent: 0, requests: [], questions: [], firewall: [], blocked: [] };
      byOrigin.set(origin, report);
    }
    return report;
  };
  const summary: TrustSummary = { patientFieldsSent: 0, requests: 0, blocked: 0, quarantined: 0, neutralized: 0 };

  for (const e of events) {
    switch (e.type) {
      case "contact": {
        const r = get(e.origin);
        r.requests.push({ at: e.at, path: e.path, query: e.query ?? null, queryLength: e.queryLength ?? 0, bytes: e.bytes ?? null, result: e.status, detail: e.detail ?? null });
        summary.requests += 1;
        summary.patientFieldsSent += e.phiFields ?? 0;
        r.patientFieldsSent += e.phiFields ?? 0;
        break;
      }
      case "consent": {
        const r = get(e.origin);
        if (e.network) r.network = e.network;
        if (e.decision === "allow_session") r.consent = "allowed for this session";
        else if (e.decision === "allow_once") r.consent = r.consent === "allowed for this session" ? r.consent : "allowed once";
        else if (e.decision === "deny") r.consent = "denied";
        else if (e.decision === "revoked") r.consent = "revoked";
        if (SENT_DECISIONS.has(e.decision) && e.requestText !== undefined) {
          r.questions.push({ at: e.at, text: e.requestText, patientFields: e.phiFields ?? 0 });
          summary.patientFieldsSent += e.phiFields ?? 0;
          r.patientFieldsSent += e.phiFields ?? 0;
        }
        if (e.decision === "blocked" && !fromFirewall(e)) {
          r.blocked.push({ at: e.at, what: "question to the node's assistant", reason: e.detail ?? "" });
          summary.blocked += 1;
        }
        break;
      }
      case "firewall": {
        get(e.origin).firewall.push({
          at: e.at,
          rule: e.rule,
          direction: e.direction,
          action: e.action,
          reason: e.reason,
          field: e.field ?? null,
          snippet: e.snippet ?? null,
          redacted: e.redacted ?? null,
        });
        if (e.action === "neutralized") summary.neutralized += 1;
        else summary.blocked += 1;
        break;
      }
      case "link": {
        if (e.decision !== "blocked") break;
        get(e.origin).blocked.push({ at: e.at, what: "link in an answer", reason: "outside ClinicalTrials.gov and the trial nodes" });
        summary.blocked += 1;
        break;
      }
      default:
        break;
    }
  }
  for (const q of quarantined) get(q.origin).quarantined = q.reason;
  summary.quarantined = quarantined.length;
  return { generatedAt: new Date(now()).toISOString(), summary, origins: [...byOrigin.values()] };
}

/** "Patient data sent: 0 fields · Requests: N · Blocked: M" */
export function summaryLine(s: TrustSummary): string {
  return `Patient data sent: ${s.patientFieldsSent} ${s.patientFieldsSent === 1 ? "field" : "fields"} · Requests: ${s.requests} · Blocked: ${s.blocked}`;
}
