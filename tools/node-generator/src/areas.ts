// The four disease areas, one trial node each. Long COVID and a rare disease were the
// first proposal (product brief §12); the Synthea sample has no code for either, so they
// were replaced with chronic kidney disease and obesity (see README "Disease areas").
// The studies of each area are listed in data/curation/<slug>.json.

export interface Area {
  /** Folder name under data/ctgov and dist/nodes. */
  slug: string;
  /** Network name: <network>.hocon, URL path segment for peers. */
  network: string;
  title: string;
  description: string;
  /** Local dev port for pnpm serve:nodes. */
  port: number;
  theme: string;
  /** ClinicalTrials.gov query.cond used to discover candidates. */
  query: string;
  sampleQueries: string[];
}

export const AREAS: readonly Area[] = [
  {
    slug: "type-2-diabetes",
    network: "t2d_trials",
    title: "Type 2 diabetes trials",
    description: "Recruiting type 2 diabetes studies from ClinicalTrials.gov, with eligibility criteria structured for private pre-screening.",
    port: 4101,
    theme: "#1b5e73",
    query: "type 2 diabetes",
    sampleQueries: [
      "Which type 2 diabetes studies are recruiting here?",
      "What HbA1c range do these studies accept?",
      "Where are the study sites?",
      "Can you enroll me in a study right now?",
    ],
  },
  {
    slug: "breast-cancer",
    network: "breast_cancer_trials",
    title: "Breast cancer trials",
    description: "Recruiting breast cancer studies from ClinicalTrials.gov, with eligibility criteria structured for private pre-screening.",
    port: 4102,
    theme: "#8a2f5b",
    query: "breast cancer",
    sampleQueries: [
      "Which breast cancer studies are recruiting here?",
      "Who can join these studies?",
      "Where are the study sites?",
      "Can you enroll me in a study right now?",
    ],
  },
  {
    slug: "chronic-kidney-disease",
    network: "ckd_trials",
    title: "Chronic kidney disease trials",
    description: "Recruiting chronic kidney disease studies from ClinicalTrials.gov, with eligibility criteria structured for private pre-screening.",
    port: 4103,
    theme: "#2f6b3a",
    query: "chronic kidney disease",
    sampleQueries: [
      "Which kidney disease studies are recruiting here?",
      "What eGFR range do these studies accept?",
      "Where are the study sites?",
      "Can you enroll me in a study right now?",
    ],
  },
  {
    slug: "obesity",
    network: "obesity_trials",
    title: "Obesity trials",
    description: "Recruiting obesity studies from ClinicalTrials.gov, with eligibility criteria structured for private pre-screening.",
    port: 4104,
    theme: "#6b4a1b",
    query: "obesity",
    sampleQueries: [
      "Which obesity studies are recruiting here?",
      "What BMI range do these studies accept?",
      "Where are the study sites?",
      "Can you enroll me in a study right now?",
    ],
  },
];

export function findArea(slug: string): Area {
  const area = AREAS.find((a) => a.slug === slug);
  if (!area) throw new Error(`Unknown area "${slug}". Known: ${AREAS.map((a) => a.slug).join(", ")}`);
  return area;
}
