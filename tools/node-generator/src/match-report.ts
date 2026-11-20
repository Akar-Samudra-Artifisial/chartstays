// Demo match report: every date-shifted Synthea subset patient x every curated study, the
// hero patient per area for the demo video, and why cells land in each tier.
// Read-only over data/: curation and patient data are never changed to force a result.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import { parseBundle, type PatientProfile } from "@chartstays/fhir-profile";
import { evaluateStudy, type StudyResult, type Verdict } from "@chartstays/matcher";
import { AREAS, type Area } from "./areas.ts";
import { loadCuration } from "./curate.ts";
import { PATHS } from "./paths.ts";
import { TIMESHIFT_REFERENCE } from "./timeshift.ts";

/** Evaluation date of the report and the golden test: the ClinicalTrials.gov retrieval date. */
export const REPORT_AS_OF = "2026-11-16";

export interface AreaStudies {
  area: Area;
  docs: CriteriaDocument[];
}

export interface PatientRow {
  /** File name in data/synthea/shifted (same name as in data/synthea/patients). */
  file: string;
  /** Synthetic first name token, e.g. "Marlin805". */
  short: string;
  profile: PatientProfile;
  results: Map<string, StudyResult>;
}

export interface Hero {
  id: string;
  area: string;
  file: string;
  short: string;
  age: number | null;
  sex: string;
  strong_match: string[];
  possible_match: string[];
  not_eligible: string[];
  reason: string;
}

export const VERDICTS: readonly Verdict[] = ["strong_match", "possible_match", "not_eligible"];
const VERDICT_SHORT: Record<Verdict, string> = { strong_match: "S", possible_match: "P", not_eligible: "N" };

export async function loadAreas(): Promise<AreaStudies[]> {
  const out: AreaStudies[] = [];
  for (const area of AREAS) {
    const curation = await loadCuration(area.slug);
    const docs: CriteriaDocument[] = [];
    for (const { nct_id } of curation.studies) {
      docs.push(JSON.parse(await readFile(path.join(PATHS.curated, `${nct_id}.criteria.json`), "utf8")) as CriteriaDocument);
    }
    out.push({ area, docs });
  }
  return out;
}

export async function loadRows(areas: AreaStudies[], asOf: string): Promise<PatientRow[]> {
  const files = (await readdir(PATHS.syntheaShifted)).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
  const rows: PatientRow[] = [];
  for (const file of files) {
    const bundle: unknown = JSON.parse(await readFile(path.join(PATHS.syntheaShifted, file), "utf8"));
    const profile = parseBundle(bundle, { asOf: new Date(`${asOf}T00:00:00Z`) });
    const results = new Map<string, StudyResult>();
    for (const { docs } of areas) for (const doc of docs) results.set(doc.nct_id, evaluateStudy(profile, doc));
    rows.push({ file, short: file.split("_")[0] ?? file, profile, results });
  }
  return rows;
}

function byVerdict(row: PatientRow, docs: CriteriaDocument[], verdict: Verdict): string[] {
  return docs.filter((d) => row.results.get(d.nct_id)?.verdict === verdict).map((d) => d.nct_id);
}

function structuredMet(row: PatientRow, docs: CriteriaDocument[]): number {
  return docs.reduce((sum, d) => sum + (row.results.get(d.nct_id)?.criteria.filter((c) => c.kind !== "free_text" && c.status === "met").length ?? 0), 0);
}

const compareKeys = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
};

/**
 * One hero per area. Ranking: has a strong_match study; has a possible_match study; has a
 * not_eligible study (contrast); then more strong, then more possible, then more met coded
 * criteria. A patient not yet picked for another area wins when it matches the best on
 * the first two points, so the demo shows different patients.
 */
export function pickHeroes(areas: AreaStudies[], rows: PatientRow[]): Hero[] {
  const used = new Set<string>();
  const heroes: Hero[] = [];
  for (const { area, docs } of areas) {
    const scored = rows.map((row) => {
      const sm = byVerdict(row, docs, "strong_match");
      const pm = byVerdict(row, docs, "possible_match");
      const ne = byVerdict(row, docs, "not_eligible");
      const key = [sm.length > 0 ? 1 : 0, pm.length > 0 ? 1 : 0, ne.length > 0 ? 1 : 0, sm.length, pm.length];
      return { row, sm, pm, ne, key, met: structuredMet(row, docs) };
    });
    scored.sort((a, b) => compareKeys(a.key, b.key) || b.met - a.met || (a.row.file < b.row.file ? -1 : 1));
    const best = scored[0]!;
    const pick = scored.find((s) => compareKeys(s.key.slice(0, 2), best.key.slice(0, 2)) === 0 && !used.has(s.row.file)) ?? best;
    used.add(pick.row.file);
    heroes.push({
      id: `demo-${area.slug}`,
      area: area.slug,
      file: pick.row.file,
      short: pick.row.short,
      age: pick.row.profile.age,
      sex: pick.row.profile.sex,
      strong_match: pick.sm,
      possible_match: pick.pm,
      not_eligible: pick.ne,
      reason: heroReason(area, pick.row, docs, pick.sm, pick.pm, pick.ne),
    });
  }
  return heroes;
}

function heroReason(area: Area, row: PatientRow, docs: CriteriaDocument[], sm: string[], pm: string[], ne: string[]): string {
  const parts: string[] = [];
  if (sm.length > 0) {
    const items = sm.map((id) => `${id}: ${row.results.get(id)!.unknowns.free_text} to confirm`);
    parts.push(`strong match for ${sm.join(", ")} (${items.join(", ")})`);
  }
  if (pm.length > 0) {
    const first = row.results.get(pm[0]!)!;
    parts.push(`possible match for ${pm.join(", ")} (e.g. ${pm[0]}: ${first.reasons[0] ?? "data missing"})`);
  }
  if (ne.length > 0) {
    const first = row.results.get(ne[0]!)!;
    parts.push(`not eligible for ${ne.join(", ")} (e.g. ${ne[0]}: ${first.reasons[0] ?? "blocked"})`);
  }
  return `${row.profile.sex}, ${row.profile.age ?? "age unknown"}, ${docs.length} ${area.title.toLowerCase()}: ${parts.join("; ")}.`;
}

interface Tally {
  key: string;
  count: number;
}

function top(map: Map<string, number>, n: number): Tally[] {
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1)).slice(0, n);
}

function unknownCategory(reason: string): string {
  if (/older than \d+ days/.test(reason)) return "lab result too old";
  if (/^No result/.test(reason)) return "lab not in record";
  if (/not recognised|cannot be converted/.test(reason)) return "unit not convertible";
  if (/^No active prescription/.test(reason)) return "medication not recorded";
  if (/is not recorded; the imported record/.test(reason)) return "supporting condition not recorded";
  if (/unconfirmed or provisional/.test(reason)) return "condition unconfirmed";
  if (/^Free-text/.test(reason)) return "free-text criterion";
  return "other";
}

export function renderMarkdown(asOf: string, areas: AreaStudies[], rows: PatientRow[], heroes: Hero[]): string {
  const totals: Record<Verdict, number> = { strong_match: 0, possible_match: 0, not_eligible: 0 };
  const unknownByCategory = new Map<string, number>();
  const unknownByCriterion = new Map<string, number>();
  const blockers = new Map<string, number>();
  for (const row of rows) {
    for (const { docs } of areas) {
      for (const doc of docs) {
        const r = row.results.get(doc.nct_id)!;
        totals[r.verdict] += 1;
        for (const c of r.criteria) {
          if (c.status === "unknown") {
            unknownByCategory.set(unknownCategory(c.reason), (unknownByCategory.get(unknownCategory(c.reason)) ?? 0) + 1);
            if (c.kind !== "free_text") unknownByCriterion.set(`${doc.nct_id} ${c.id} (${c.label})`, (unknownByCriterion.get(`${doc.nct_id} ${c.id} (${c.label})`) ?? 0) + 1);
          }
          const blocks = (c.type === "inclusion" && c.status === "not_met") || (c.type === "exclusion" && c.status === "met");
          if (blocks) blockers.set(`${c.type} ${c.label}`, (blockers.get(`${c.type} ${c.label}`) ?? 0) + 1);
        }
      }
    }
  }
  const studies = areas.flatMap((a) => a.docs);
  const withFreeText = studies.filter((d) => d.free_text.length > 0).length;
  const cells = rows.length * studies.length;

  const out: string[] = [];
  out.push("# Match matrix (Synthea subset × curated studies)", "");
  out.push(`Generated by \`pnpm match:report\`; profiles evaluated on ${asOf}, lab results older than 365 days count as unknown.`);
  out.push(`Synthetic patients only, from \`data/synthea/shifted\`: dates shifted so each patient's latest record date is ${TIMESHIFT_REFERENCE} (\`pnpm synthea:timeshift\`).`);
  out.push("Pre-screening demo, not medical advice; criteria curated by the project team, not reviewed by clinicians.", "");
  out.push("Cell: tier (**S** strong_match, **P** possible_match, **N** not_eligible), then met / coded unknown / free-text items to confirm.", "");
  out.push("## Summary", "");
  out.push(`| Tier | Cells |`, `| --- | --- |`);
  for (const v of VERDICTS) out.push(`| ${v} | ${totals[v]} |`);
  out.push(`| total | ${cells} |`, "");

  out.push("## Patients", "", "| Patient | Sex | Age | Active conditions | Medications |", "| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    out.push(`| ${row.short} | ${row.profile.sex} | ${row.profile.age ?? "?"} | ${row.profile.conditions.filter((c) => c.active).length} | ${row.profile.medications.length} |`);
  }
  out.push("");

  for (const { area, docs } of areas) {
    out.push(`## ${area.title}`, "");
    out.push(`| Patient | ${docs.map((d) => d.nct_id).join(" | ")} |`, `| --- | ${docs.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      const cellsText = docs.map((d) => {
        const r = row.results.get(d.nct_id)!;
        return `${VERDICT_SHORT[r.verdict]} ${r.counts.met}/${r.unknowns.structured}/${r.unknowns.free_text}`;
      });
      out.push(`| ${row.short} | ${cellsText.join(" | ")} |`);
    }
    out.push("");
  }

  out.push("## Demo heroes", "", "Saved in `data/demo-patients.json` and bundled into the patient app.", "");
  for (const h of heroes) out.push(`- **${h.area}**: ${h.short} — ${h.reason}`);
  out.push("");

  out.push("## Why cells land where they do", "");
  out.push(
    `${withFreeText} of ${studies.length} studies have free-text criteria. Free text never decides the tier: it is listed as items to confirm with a doctor. ` +
      `${totals.strong_match} cells are strong_match (every coded criterion decided in favour), ${totals.possible_match} possible_match (a coded criterion is unknown), ${totals.not_eligible} not_eligible.`,
    "",
  );
  out.push("Unknown criteria by cause:", "", "| Cause | Count |", "| --- | --- |");
  for (const t of top(unknownByCategory, 10)) out.push(`| ${t.key} | ${t.count} |`);
  out.push("", "Coded criteria most often unknown:", "", "| Criterion | Patients |", "| --- | --- |");
  for (const t of top(unknownByCriterion, 10)) out.push(`| ${t.key} | ${t.count} |`);
  out.push("", "Most frequent blockers (inclusion not met / exclusion met):", "", "| Criterion | Cells |", "| --- | --- |");
  for (const t of top(blockers, 10)) out.push(`| ${t.key} | ${t.count} |`);
  out.push("");
  return out.join("\n");
}
