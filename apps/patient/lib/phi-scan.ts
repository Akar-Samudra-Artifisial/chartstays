// Health-data firewall for text leaving the app's own agents: questions to a trial node's
// assistant are scanned for terms derived from the patient profile. A hit blocks the question.
// Terms: condition and medication names and codes, their significant words, common synonyms
// and abbreviations of the profile's conditions (T2D, CKD, BMI, ...), key lab names and values
// (with rounding variants), the age and age band, and words that reveal the sex.
import type { PatientProfile } from "@chartstays/fhir-profile";
import { KEY_LABS } from "./key-labs.ts";
import { normalizeForScan, originalRange, scanForms } from "./normalize.ts";
import { ageBand } from "./profile-summary.ts";

/** What a detected term reveals, shown next to each highlight in the UI. */
export type PhiKind = "condition" | "medication" | "lab" | "lab value" | "age" | "sex";

export interface ProfileTerms {
  /** Case-insensitive phrases matched anywhere (full condition and medication names). */
  phrases: string[];
  /** Words, codes and numbers, matched case-insensitively as whole tokens. */
  tokens: string[];
  /** The kind of each phrase and token (lower case); the first kind a term was added with. */
  kinds: Record<string, PhiKind>;
}

const MIN_PHRASE = 4;
const MIN_WORD = 5;

/** Synonyms and abbreviations, added when a profile condition's name matches the pattern. */
const CONDITION_SYNONYMS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/diabet|glyc|insulin/i, ["diabetes", "diabetic", "t2d", "t2dm", "dm2", "dm", "type 2", "type ii", "niddm", "prediabetes", "hyperglycemia", "hba1c", "a1c", "glucose", "blood sugar", "insulin"]],
  [/kidney|renal|nephr|glomerul/i, ["kidney", "kidneys", "renal", "ckd", "egfr", "gfr", "nephropathy", "dialysis", "albuminuria", "proteinuria"]],
  [/breast|mammar/i, ["breast", "breast cancer", "mastectomy", "lumpectomy", "her2", "er+", "hr+", "tnbc"]],
  [/neoplasm|cancer|carcinoma|malignan|tumou?r|lymphoma|leuk(a)?emia|melanoma|sarcoma|metasta/i, ["cancer", "carcinoma", "tumor", "tumour", "malignancy", "malignant", "oncology", "chemotherapy", "radiotherapy", "metastatic"]],
  [/obes|body mass index|bmi|overweight/i, ["obesity", "obese", "overweight", "bmi", "body mass index", "weight loss"]],
  [/hypertens|blood pressure/i, ["hypertension", "hypertensive", "high blood pressure", "htn", "blood pressure"]],
  [/lipid|cholesterol|triglycerid/i, ["cholesterol", "hyperlipidemia", "dyslipidemia", "lipid", "lipids", "ldl", "hdl", "triglycerides", "statin"]],
  [/an(a)?emia/i, ["anemia", "anaemia", "anemic"]],
  [/heart|cardi|coronary|myocard|atrial/i, ["heart", "cardiac", "coronary", "heart attack", "heart failure", "myocardial", "afib"]],
  [/neuropath/i, ["neuropathy", "neuropathic"]],
  [/retinopath/i, ["retinopathy"]],
  [/asthma/i, ["asthma", "asthmatic"]],
  [/pulmonary|copd|emphysema|bronch/i, ["copd", "lung", "lungs", "emphysema", "bronchitis"]],
  [/depress/i, ["depression", "depressed"]],
  [/anxiety/i, ["anxiety"]],
  [/stroke|cerebrovascular/i, ["stroke"]],
];

/** Lab synonyms by LOINC, added when the profile has the lab. */
const LAB_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  "4548-4": ["hba1c", "a1c", "hemoglobin a1c", "glycated hemoglobin"],
  "33914-3": ["egfr", "gfr", "filtration rate"],
  "39156-5": ["bmi", "body mass index"],
  "29463-7": ["weight", "body weight"],
  "8480-6": ["blood pressure", "systolic"],
  "8462-4": ["blood pressure", "diastolic"],
  "718-7": ["hemoglobin", "haemoglobin"],
  "14959-1": ["albumin", "uacr", "acr"],
  "2823-3": ["potassium"],
  "6298-4": ["potassium"],
};

const SEX_WORDS: Readonly<Record<string, readonly string[]>> = {
  female: ["female", "woman", "women", "she", "her", "hers", "lady", "girl"],
  male: ["male", "man", "men", "he", "him", "his", "gentleman", "boy"],
};

/** Words too generic to block on their own. */
const STOP_WORDS = new Set([
  "chronic", "acute", "disorder", "disease", "finding", "history", "stage", "primary", "secondary", "severe", "moderate",
  "unspecified", "situation", "condition", "associated", "without", "related", "level", "other", "tablet", "tablets",
  "extended", "release", "injection", "suspension", "solution", "units", "prefilled", "syringe", "human", "hydrochloride",
  "capsule", "delayed", "topical", "inhaler", "metered", "actuat", "product", "index", "score", "ratio", "count", "total", "serum",
  "plasma", "blood", "normal", "abnormal", "status", "using", "patient", "medication", "procedure", "trial", "trials", "study",
  "studies", "criteria", "network", "manifest", "sites",
]);

function stripTag(display: string): string {
  // "Diabetes mellitus type 2 (disorder)" -> "Diabetes mellitus type 2"
  return display.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= MIN_WORD && !STOP_WORDS.has(w));
}

/** The value as written in a sentence, at 2, 1 and 0 decimals, plus one step either side at 1 decimal. */
function valueVariants(value: number): string[] {
  const out = new Set<string>();
  const round = (v: number, d: number) => String(Math.round(v * 10 ** d) / 10 ** d);
  for (const d of [2, 1, 0]) out.add(round(value, d));
  const tenth = Math.round(value * 10) / 10;
  out.add(round(tenth - 0.1, 1));
  out.add(round(tenth + 0.1, 1));
  // Written with trailing zeros ("7.0", "7.30").
  for (const v of [value, tenth - 0.1, tenth + 0.1]) {
    out.add(v.toFixed(1));
    out.add(v.toFixed(2));
  }
  // Single digits are too common in ordinary text to block on.
  return [...out].filter((v) => v.replace(/\D/g, "").length >= 2);
}

export function profileTerms(profile: PatientProfile): ProfileTerms {
  const phrases = new Set<string>();
  const tokens = new Set<string>();
  const kinds: Record<string, PhiKind> = {};
  const add = (set: Set<string>, term: string, kind: PhiKind): void => {
    const key = term.toLowerCase();
    set.add(key);
    kinds[key] ??= kind;
  };
  for (const c of profile.conditions) {
    if (!c.active) continue;
    const name = stripTag(c.display).toLowerCase();
    if (name.length >= MIN_PHRASE) add(phrases, name, "condition");
    if (c.code) add(tokens, c.code, "condition");
    for (const w of significantWords(name)) add(tokens, w, "condition");
    for (const [pattern, synonyms] of CONDITION_SYNONYMS) if (pattern.test(name)) for (const s of synonyms) add(tokens, s, "condition");
  }
  for (const m of profile.medications) {
    const name = m.display.toLowerCase().trim();
    if (name.length >= MIN_PHRASE) add(phrases, name, "medication");
    if (m.rxnorm) add(tokens, m.rxnorm, "medication");
    for (const w of significantWords(name)) add(tokens, w, "medication");
  }
  for (const [loinc] of KEY_LABS) {
    const o = profile.observations[loinc];
    if (o === undefined || typeof o.value !== "number" || !Number.isFinite(o.value)) continue;
    for (const v of valueVariants(o.value)) add(tokens, v, "lab value");
    for (const s of LAB_SYNONYMS[loinc] ?? []) add(tokens, s, "lab");
  }
  if (profile.age !== null && Number.isFinite(profile.age)) {
    add(tokens, String(profile.age), "age");
    const band = ageBand(profile.age);
    if (band !== null) add(tokens, band, "age");
  }
  for (const w of SEX_WORDS[profile.sex] ?? []) add(tokens, w, "sex");
  return { phrases: [...phrases], tokens: [...tokens], kinds };
}

function tokenPattern(token: string, flags: string): RegExp {
  return new RegExp(`(?<![\\w.])${escape(token)}(?![\\w]|\\.\\d)`, flags);
}

/** Each term in the scan form ("type-2" and "type 2" are the same term). */
function normalizedTerms(terms: ProfileTerms): { term: string; form: string; token: boolean }[] {
  return [
    ...terms.phrases.map((term) => ({ term, form: normalizeForScan(term).trim(), token: false })),
    ...terms.tokens.map((term) => ({ term, form: normalizeForScan(term).trim(), token: true })),
  ].filter((t) => t.form.length > 0);
}

/** Every occurrence of a term in the normalized forms of `text`, as ranges of the original text. */
function termMatches(text: string, terms: ProfileTerms): { term: string; start: number; end: number }[] {
  const out: { term: string; start: number; end: number }[] = [];
  const list = normalizedTerms(terms);
  for (const form of scanForms(text)) {
    for (const { term, form: t, token } of list) {
      if (token) {
        for (const m of form.text.matchAll(tokenPattern(t, "g"))) {
          const at = m.index ?? 0;
          out.push({ term, ...originalRange(form, at, at + m[0].length) });
        }
      } else {
        for (let at = form.text.indexOf(t); at !== -1; at = form.text.indexOf(t, at + 1)) out.push({ term, ...originalRange(form, at, at + t.length) });
      }
    }
  }
  return out;
}

/**
 * The profile terms found in `text`; empty when none. The text is normalized first (look-alike
 * letters, invisible characters, percent-encoding, separators, number words, spelled-out words).
 */
export function findProfileTerms(text: string, terms: ProfileTerms): string[] {
  return [...new Set(termMatches(text, terms).map((m) => m.term))];
}

export interface PhiSpan {
  start: number;
  end: number;
  kind: PhiKind;
}

/** A piece of scanned text: plain text, or a detected term with its kind. */
export type PhiSegment = { text: string; kind?: undefined } | { text: string; kind: PhiKind };

export interface PhiScan {
  status: "clean" | "blocked";
  spans: PhiSpan[];
}

/**
 * Where profile terms occur in `text`, as non-overlapping spans (a longer match wins over a
 * shorter one inside it). `blocked` when there is at least one; same terms as findProfileTerms.
 */
export function scanText(text: string, terms: ProfileTerms): PhiScan {
  const raw: PhiSpan[] = termMatches(text, terms)
    .filter((m) => m.end > m.start)
    .map((m) => ({ start: m.start, end: m.end, kind: terms.kinds[m.term] ?? "condition" }));
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: PhiSpan[] = [];
  for (const span of raw) {
    const last = spans.at(-1);
    if (last !== undefined && span.start < last.end) {
      if (span.end > last.end) spans[spans.length - 1] = { ...last, end: span.end };
      continue;
    }
    spans.push(span);
  }
  return { status: spans.length > 0 ? "blocked" : "clean", spans };
}

/** `text` split into plain and detected segments, for highlighting. */
export function phiSegments(text: string, spans: readonly PhiSpan[]): PhiSegment[] {
  const out: PhiSegment[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) out.push({ text: text.slice(at, span.start) });
    out.push({ text: text.slice(span.start, span.end), kind: span.kind });
    at = span.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/**
 * Segments with every detected value replaced by its kind, so the result can be logged and
 * exported without the health data itself.
 */
export function redactedSegments(text: string, spans: readonly PhiSpan[]): PhiSegment[] {
  return phiSegments(text, spans).map((s) => (s.kind === undefined ? s : { text: `[${s.kind}]`, kind: s.kind }));
}
