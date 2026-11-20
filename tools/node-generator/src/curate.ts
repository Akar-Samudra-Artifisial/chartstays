// Turn a ClinicalTrials.gov snapshot plus a hand-written curation map into criteria.json.
//
// Every eligibility line starts as free text. A curation map entry either marks a line
// as covered by an automatic criterion (age, sex) or attaches structured criteria to it.
// Codes in the map are checked against the Synthea code inventory by `pnpm validate`.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  CriteriaDocument,
  FreeTextCriterion,
  GroupLogic,
  StructuredCriterion,
} from "@chartstays/criteria-schema";
import { criteriaSourceFrom, parseCtgovAge, type Snapshot } from "./ctgov.ts";
import { splitEligibility, type EligibilityLine } from "./eligibility.ts";
import { PATHS } from "./paths.ts";

type Distributive<T> = T extends unknown ? Omit<T, "id" | "type" | "source_text"> : never;
/** A structured criterion as written in a curation map; id, type and source_text are filled in. */
export type MappedCriterion = Distributive<StructuredCriterion>;

export interface CoveredEntry {
  /** Line id from splitEligibility, e.g. "inc-3". */
  from: string;
  /** Text the line must contain, so a changed record cannot be mapped silently. */
  match: string;
  /** Id of the automatic criterion that already expresses this line (inc-0a age, inc-0b sex). */
  covered_by: "inc-0a" | "inc-0b";
}

export interface StructuredEntry {
  from: string;
  match: string;
  /** Keep the line in free_text too, when the structured part covers it only partly. */
  keep_free_text?: boolean;
  /**
   * Combine the structured criteria of this line as one logic group ("any": one member
   * is enough). Without it each criterion follows the default rule on its own.
   */
  group_logic?: GroupLogic;
  structured: MappedCriterion[];
}

export type MapEntry = CoveredEntry | StructuredEntry;

export interface StudyCuration {
  nct_id: string;
  notes?: string;
  map: MapEntry[];
}

export interface AreaCuration {
  area: string;
  studies: StudyCuration[];
}

export async function loadCuration(slug: string): Promise<AreaCuration> {
  const file = path.join(PATHS.curation, `${slug}.json`);
  const data = JSON.parse(await readFile(file, "utf8")) as AreaCuration;
  if (data.area !== slug || !Array.isArray(data.studies)) {
    throw new Error(`${file}: expected {"area": "${slug}", "studies": [...]}`);
  }
  return data;
}

export async function loadSnapshot(slug: string, nctId: string): Promise<Snapshot> {
  const file = path.join(PATHS.ctgov, slug, `${nctId}.json`);
  return JSON.parse(await readFile(file, "utf8")) as Snapshot;
}

/**
 * True when a criteria file read from disk equals a fresh curate() result. Compared as
 * JSON, so fields left undefined in memory do not count as differences.
 */
export function matchesCuration(onDisk: unknown, fresh: CriteriaDocument): boolean {
  return isDeepStrictEqual(onDisk, JSON.parse(JSON.stringify(fresh)));
}

function ageLabel(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `Age ${min} to ${max} years`;
  if (min !== null) return `Age ${min} years or older`;
  return `Age ${max} years or younger`;
}

function requestedFields(structured: StructuredCriterion[]): string[] {
  const fields = new Set<string>();
  for (const c of structured) {
    if (c.kind === "age") fields.add("age");
    else if (c.kind === "sex") fields.add("sex");
    else if (c.kind === "condition") fields.add("conditions");
    else if (c.kind === "medication") fields.add("medications");
    else fields.add(`labs:${c.loinc}`);
  }
  return [...fields];
}

/** Build the criteria document. Throws when the map does not fit the snapshot. */
export function curate(snapshot: Snapshot, curation: StudyCuration): CriteriaDocument {
  const p = snapshot.study.protocolSection;
  const nctId = p.identificationModule.nctId;
  if (nctId !== curation.nct_id) throw new Error(`curation for ${curation.nct_id} applied to ${nctId}`);
  const e = p.eligibilityModule;
  const criteriaText = e.eligibilityCriteria ?? "";
  const lines = splitEligibility(criteriaText);
  const byId = new Map<string, EligibilityLine>(lines.map((l) => [l.id, l]));

  const structured: StructuredCriterion[] = [];
  const automatic = new Set<string>();
  const min = parseCtgovAge(e.minimumAge);
  const max = parseCtgovAge(e.maximumAge);
  if (min !== null || max !== null) {
    structured.push({
      id: "inc-0a", type: "inclusion", kind: "age", label: ageLabel(min, max),
      source_text: `ClinicalTrials.gov age limits: ${e.minimumAge ?? "none"} minimum, ${e.maximumAge ?? "none"} maximum`,
      min, max, unit: "years",
    });
    automatic.add("inc-0a");
  }
  if (e.sex === "FEMALE" || e.sex === "MALE") {
    structured.push({
      id: "inc-0b", type: "inclusion", kind: "sex",
      label: e.sex === "FEMALE" ? "Female participants" : "Male participants",
      source_text: `ClinicalTrials.gov sex: ${e.sex}`,
      sex: e.sex === "FEMALE" ? "female" : "male",
    });
    automatic.add("inc-0b");
  }

  const removed = new Set<string>();
  const seen = new Set<string>();
  for (const entry of curation.map) {
    const line = byId.get(entry.from);
    if (!line) throw new Error(`${nctId}: map refers to unknown line ${entry.from}`);
    if (seen.has(entry.from)) throw new Error(`${nctId}: line ${entry.from} mapped twice`);
    seen.add(entry.from);
    if (!line.text.toLowerCase().includes(entry.match.toLowerCase())) {
      throw new Error(`${nctId}: line ${entry.from} no longer contains "${entry.match}": ${line.text}`);
    }
    if ("covered_by" in entry) {
      if (!automatic.has(entry.covered_by)) throw new Error(`${nctId}: ${entry.from} covered by missing ${entry.covered_by}`);
      if (entry.covered_by === "inc-0a") {
        const numbers = new Set((line.text.match(/\d+/g) ?? []).map(Number));
        for (const bound of [min, max]) {
          if (bound !== null && !numbers.has(bound)) {
            throw new Error(`${nctId}: ${entry.from} is covered by inc-0a but does not state age ${bound}: ${line.text}`);
          }
        }
      }
      removed.add(line.id);
      continue;
    }
    if (!entry.structured.length) throw new Error(`${nctId}: ${entry.from} has no structured criteria`);
    for (const c of entry.structured) {
      // One RxNorm product never stands for a drug class ("insulin", "metformin").
      if (c.kind === "medication" && c.rxnorm.length === 1 && !entry.keep_free_text) {
        throw new Error(`${nctId}: ${entry.from} maps a medication to the single product ${c.rxnorm[0]}; set keep_free_text`);
      }
    }
    if (entry.group_logic !== undefined && entry.structured.length < 2) {
      throw new Error(`${nctId}: ${entry.from} sets group_logic but has fewer than two criteria`);
    }
    const suffix = entry.keep_free_text || entry.structured.length > 1;
    entry.structured.forEach((c, i) => {
      const id = suffix ? `${line.id}${String.fromCharCode(97 + i)}` : line.id;
      const group = entry.group_logic === undefined ? {} : { group: line.id, group_logic: entry.group_logic };
      structured.push({ ...c, id, type: line.type, source_text: line.text, ...group } as StructuredCriterion);
    });
    if (!entry.keep_free_text) removed.add(line.id);
  }

  const freeText: FreeTextCriterion[] = lines
    .filter((l) => !removed.has(l.id))
    .map((l) => ({ id: l.id, type: l.type, text: l.text }));

  const doc: CriteriaDocument = {
    schema_version: 1,
    nct_id: nctId,
    title: p.identificationModule.briefTitle,
    status: p.statusModule.overallStatus,
    conditions: p.conditionsModule?.conditions ?? [],
    source: criteriaSourceFrom(snapshot),
    eligibility: {
      criteria_text: criteriaText,
      sex: e.sex ?? "ALL",
      minimum_age: e.minimumAge ?? null,
      maximum_age: e.maximumAge ?? null,
      healthy_volunteers: e.healthyVolunteers ?? null,
    },
    structured,
    free_text: freeText,
    requested_fields_for_inquiry: requestedFields(structured),
    curation: { method: "manual" },
  };
  if (curation.notes) doc.curation = { method: "manual", notes: curation.notes };
  return doc;
}
