// ClinicalTrials.gov API v2 access and parsing of the stored snapshots.
// Field paths: spike/SPIKE-REPORT.md §6. Data is fetched at build time only; the
// API rejects CORS preflight, and nodes must work offline from data/ctgov.

import type { CriteriaSource } from "@chartstays/criteria-schema";

export const CTGOV_API = "https://clinicaltrials.gov/api/v2";

/** The minimal field list the generator needs. */
export const SNAPSHOT_FIELDS = [
  "NCTId",
  "BriefTitle",
  "OverallStatus",
  "LastUpdatePostDate",
  "StartDate",
  "PrimaryCompletionDate",
  "Phase",
  "StudyType",
  "EnrollmentCount",
  "LeadSponsorName",
  "Condition",
  "BriefSummary",
  "EligibilityCriteria",
  "MinimumAge",
  "MaximumAge",
  "Sex",
  "HealthyVolunteers",
  "LocationFacility",
  "LocationCity",
  "LocationState",
  "LocationCountry",
  "LocationStatus",
] as const;

interface DateStruct { date?: string }

/** The subset of a v2 study record the snapshot fields produce. */
export interface CtgovStudy {
  protocolSection: {
    identificationModule: { nctId: string; briefTitle: string };
    statusModule: {
      overallStatus: string;
      lastUpdatePostDateStruct?: DateStruct;
      startDateStruct?: DateStruct;
      primaryCompletionDateStruct?: DateStruct;
    };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
    descriptionModule?: { briefSummary?: string };
    conditionsModule?: { conditions?: string[] };
    designModule?: { studyType?: string; phases?: string[]; enrollmentInfo?: { count?: number } };
    eligibilityModule: {
      eligibilityCriteria?: string;
      healthyVolunteers?: boolean;
      sex?: "ALL" | "FEMALE" | "MALE";
      minimumAge?: string;
      maximumAge?: string;
    };
    contactsLocationsModule?: {
      locations?: { facility?: string; city?: string; state?: string; country?: string; status?: string }[];
    };
  };
}

/** One file in data/ctgov/<area>/<NCT>.json: the raw study plus how it was fetched. */
export interface Snapshot {
  retrieved: string;
  api_version: string | null;
  request_url: string;
  study: CtgovStudy;
}

const AGE_UNITS: Record<string, number> = {
  year: 1,
  years: 1,
  month: 1 / 12,
  months: 1 / 12,
  week: 7 / 365.25,
  weeks: 7 / 365.25,
  day: 1 / 365.25,
  days: 1 / 365.25,
};

/**
 * Parse a ClinicalTrials.gov age such as "18 Years" or "6 Months" into years.
 * Empty or missing means no limit and returns null. Unknown formats throw, so a data
 * change cannot silently drop an age limit.
 */
export function parseCtgovAge(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed === "" || /^n\/?a$/i.test(trimmed)) return null;
  const match = /^(\d+(?:\.\d+)?)\s+([A-Za-z]+)$/.exec(trimmed);
  const unit = match?.[2]?.toLowerCase();
  const factor = unit === undefined ? undefined : AGE_UNITS[unit];
  if (!match || factor === undefined) {
    throw new Error(`Unrecognised ClinicalTrials.gov age "${text}"`);
  }
  return Math.round(Number(match[1]) * factor * 100) / 100;
}

export function studyUrl(nctId: string): string {
  return `https://clinicaltrials.gov/study/${nctId}`;
}

/** Attribution block for criteria.json, built from a snapshot. */
export function criteriaSourceFrom(snapshot: Snapshot): CriteriaSource {
  const study = snapshot.study.protocolSection;
  const nctId = study.identificationModule.nctId;
  const source: CriteriaSource = {
    name: "ClinicalTrials.gov",
    nct_id: nctId,
    url: studyUrl(nctId),
    retrieved: snapshot.retrieved,
    modified: "Eligibility criteria structured and coded (SNOMED CT, LOINC, RxNorm) by ChartStays from the ClinicalTrials.gov text; the original text is kept unchanged in eligibility.criteria_text. Criteria curated by the project team, not reviewed by clinicians; pre-screening only.",
  };
  const updated = study.statusModule.lastUpdatePostDateStruct?.date;
  if (updated) source.last_update_posted = updated;
  return source;
}

export interface StudyFacts {
  nct_id: string;
  title: string;
  status: string;
  conditions: string[];
  phases: string[];
  study_type: string | null;
  sponsor: string | null;
  summary: string | null;
  enrollment: number | null;
  start_date: string | null;
  primary_completion_date: string | null;
  last_update_posted: string | null;
  url: string;
}

export function studyFacts(snapshot: Snapshot): StudyFacts {
  const s = snapshot.study.protocolSection;
  return {
    nct_id: s.identificationModule.nctId,
    title: s.identificationModule.briefTitle,
    status: s.statusModule.overallStatus,
    conditions: s.conditionsModule?.conditions ?? [],
    phases: s.designModule?.phases ?? [],
    study_type: s.designModule?.studyType ?? null,
    sponsor: s.sponsorCollaboratorsModule?.leadSponsor?.name ?? null,
    summary: s.descriptionModule?.briefSummary ?? null,
    enrollment: s.designModule?.enrollmentInfo?.count ?? null,
    start_date: s.statusModule.startDateStruct?.date ?? null,
    primary_completion_date: s.statusModule.primaryCompletionDateStruct?.date ?? null,
    last_update_posted: s.statusModule.lastUpdatePostDateStruct?.date ?? null,
    url: studyUrl(s.identificationModule.nctId),
  };
}

/** Logistics document published at logistics/<NCT>.json for logistics_agent. */
export function logisticsFrom(snapshot: Snapshot): Record<string, unknown> {
  const facts = studyFacts(snapshot);
  const locations = snapshot.study.protocolSection.contactsLocationsModule?.locations ?? [];
  return {
    nct_id: facts.nct_id,
    title: facts.title,
    status: facts.status,
    sponsor: facts.sponsor,
    study_type: facts.study_type,
    phases: facts.phases,
    enrollment_target: facts.enrollment,
    start_date: facts.start_date,
    primary_completion_date: facts.primary_completion_date,
    location_count: locations.length,
    locations: locations.map((l) => ({
      facility: l.facility ?? null,
      city: l.city ?? null,
      state: l.state ?? null,
      country: l.country ?? null,
      status: l.status ?? null,
    })),
    contacts: `Study contacts are listed on the ClinicalTrials.gov record: ${facts.url}`,
    source: {
      name: "ClinicalTrials.gov",
      url: facts.url,
      retrieved: snapshot.retrieved,
      last_update_posted: facts.last_update_posted,
      modified: "Fields selected and renamed by ChartStays; values unchanged.",
    },
  };
}
