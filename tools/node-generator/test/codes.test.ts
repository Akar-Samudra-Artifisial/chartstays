import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import { AREAS } from "../src/areas.ts";
import { curate, loadCuration, loadSnapshot, matchesCuration } from "../src/curate.ts";
import { PATHS } from "../src/paths.ts";

// Every code used by data/curated, with the Synthea display it was reviewed against.
// A new code, or a display change in the inventory, must be reviewed and added here.
const EXPECTED: Record<string, string> = {
  "Condition|22298006": "Myocardial infarction (disorder)",
  "Condition|254837009": "Malignant neoplasm of breast (disorder)",
  "Condition|401303003": "Acute ST segment elevation myocardial infarction (disorder)",
  "Condition|401314000": "Acute non-ST segment elevation myocardial infarction (disorder)",
  "Condition|414545008": "Ischemic heart disease (disorder)",
  "Condition|44054006": "Diabetes mellitus type 2 (disorder)",
  "Condition|443165006": "Osteoporotic fracture of bone (disorder)",
  "Condition|449868002": "Smokes tobacco daily (finding)",
  "Condition|48724000": "Mitral valve regurgitation (disorder)",
  "Condition|60573004": "Aortic valve stenosis (disorder)",
  "Condition|64859006": "Osteoporosis (disorder)",
  "Condition|88805009": "Chronic congestive heart failure (disorder)",
  "Condition|93143009": "Leukemia, disease (disorder)",
  "Condition|94503003": "Metastatic malignant neoplasm to prostate (disorder)",
  "MedicationRequest|1049504": "Abuse-Deterrent 12 HR Oxycodone Hydrochloride 10 MG Extended Release Oral Tablet [Oxycontin]",
  "MedicationRequest|1049625": "Acetaminophen 325 MG / Oxycodone Hydrochloride 10 MG Oral Tablet [Percocet]",
  "MedicationRequest|106892": "insulin isophane, human 70 UNT/ML / insulin, regular, human 30 UNT/ML Injectable Suspension [Humulin]",
  "MedicationRequest|1860154": "Abuse-Deterrent 12 HR Oxycodone Hydrochloride 15 MG Extended Release Oral Tablet",
  "MedicationRequest|1860491": "12 HR Hydrocodone Bitartrate 10 MG Extended Release Oral Capsule",
  "MedicationRequest|245134": "72 HR Fentanyl 0.025 MG/HR Transdermal System",
  "MedicationRequest|835603": "tramadol hydrochloride 50 MG Oral Tablet",
  "MedicationRequest|856987": "Acetaminophen 300 MG / Hydrocodone Bitartrate 5 MG Oral Tablet",
  "MedicationRequest|857005": "Acetaminophen 325 MG / HYDROcodone Bitartrate 7.5 MG Oral Tablet",
  "MedicationRequest|860975": "24 HR Metformin hydrochloride 500 MG Extended Release Oral Tablet",
  "MedicationRequest|861467": "Meperidine Hydrochloride 50 MG Oral Tablet",
  "MedicationRequest|993770": "Acetaminophen 300 MG / Codeine Phosphate 15 MG Oral Tablet",
  "Observation|14959-1": "Microalbumin/Creatinine [Mass Ratio] in Urine",
  "Observation|1751-7": "Albumin [Mass/volume] in Serum or Plasma",
  "Observation|2571-8": "Triglyceride [Mass/volume] in Serum or Plasma",
  "Observation|2823-3": "Potassium [Moles/volume] in Serum or Plasma",
  "Observation|29463-7": "Body Weight",
  "Observation|33914-3": "Glomerular filtration rate [Volume Rate/Area] in Serum or Plasma by Creatinine-based formula (MDRD)/1.73 sq M",
  "Observation|39156-5": "Body mass index (BMI) [Ratio]",
  "Observation|4548-4": "Hemoglobin A1c/Hemoglobin.total in Blood",
  "Observation|6298-4": "Potassium [Moles/volume] in Blood",
  "Observation|6690-2": "Leukocytes [#/volume] in Blood by Automated count",
  "Observation|718-7": "Hemoglobin [Mass/volume] in Blood",
  "Observation|777-3": "Platelets [#/volume] in Blood by Automated count",
};

// Codes taken out of the malignancy sets on review: neoplasm of prostate may be benign,
// carcinoma in situ is not invasive.
const NOT_MALIGNANCY = ["126906006", "92691004"];

async function curatedDocs(): Promise<CriteriaDocument[]> {
  const files = (await readdir(PATHS.curated)).filter((f) => f.endsWith(".criteria.json"));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(PATHS.curated, f), "utf8")) as CriteriaDocument));
}

function usedCodes(doc: CriteriaDocument): string[] {
  return doc.structured.flatMap((c) => {
    if (c.kind === "condition") return c.codes.snomed.map((code) => `Condition|${code}`);
    if (c.kind === "lab") return [`Observation|${c.loinc}`];
    if (c.kind === "medication") return c.rxnorm.map((code) => `MedicationRequest|${code}`);
    return [];
  });
}

test("every code in data/curated has the reviewed Synthea display", async () => {
  const inventory = JSON.parse(await readFile(PATHS.syntheaInventory, "utf8")) as {
    codes: { resource: string; code: string; display: string }[];
  };
  const display = new Map(inventory.codes.map((c) => [`${c.resource}|${c.code}`, c.display]));
  const used = new Set((await curatedDocs()).flatMap(usedCodes));
  for (const key of used) {
    assert.ok(key in EXPECTED, `${key} is used but not in the reviewed code table`);
  }
  for (const [key, expected] of Object.entries(EXPECTED)) {
    assert.equal(display.get(key), expected, `${key} display in code-inventory.json`);
  }
});

test("malignancy criteria leave out benign and in-situ codes", async () => {
  for (const doc of await curatedDocs()) {
    for (const c of doc.structured) {
      if (c.kind !== "condition" || !/malignan/i.test(c.label)) continue;
      for (const code of NOT_MALIGNANCY) assert.ok(!c.codes.snomed.includes(code), `${doc.nct_id} ${c.id} lists ${code}`);
    }
  }
});

test("data/curated equals a fresh curate run (no stale curation)", async () => {
  for (const area of AREAS) {
    for (const study of (await loadCuration(area.slug)).studies) {
      const file = path.join(PATHS.curated, `${study.nct_id}.criteria.json`);
      const onDisk: unknown = JSON.parse(await readFile(file, "utf8"));
      assert.ok(matchesCuration(onDisk, curate(await loadSnapshot(area.slug, study.nct_id), study)), `${file} is stale`);
    }
  }
});
