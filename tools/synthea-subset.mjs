// Build data/synthea/ from an extracted Synthea FHIR R4 sample download.
//
//   node tools/synthea-subset.mjs <extracted-folder>
//
// Writes:
//   data/synthea/code-inventory.json  every Condition (SNOMED), Observation (LOINC) and
//                                      MedicationRequest (RxNorm) code in the whole sample,
//                                      with the number of patients that have it.
//   data/synthea/patients/<file>.json  the selected patients, trimmed to the resource types
//                                      the matcher reads (see KEEP).
// The input is untrusted data: it is only parsed as JSON.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const OUT = path.join(ROOT, "data", "synthea");

/** Selected patients (file name prefix) and why each one is kept. */
const PATIENTS = {
  "Angelyn934_Kandra693_Harris789": "female, b. 1965: type 2 diabetes, diabetic kidney disease, breast cancer, obesity",
  "Noriko180_Yolonda722_Ullrich385": "female, b. 1977: breast cancer",
  "Marlin805_Nienow652": "male, b. 1966: type 2 diabetes",
  "Raquel318_Sommer719_Greenholt190": "female, b. 1978: type 2 diabetes",
  "Stephan15_Emmerich580": "male, b. 1963: chronic kidney disease stage 1-2",
  "Asia282_Prosacco716": "female, b. 1959: obesity (BMI 30+)",
  "Carmelina668_Jeane173_Shanahan202": "female, b. 1990: obesity (BMI 30+)",
  "Brett333_Kirlin939": "male, b. 1998: obesity (BMI 30+)",
};

/** Resource types the patient profile needs (product brief §10). */
const KEEP = new Set(["Patient", "Condition", "Observation", "MedicationRequest"]);

const SYSTEMS = {
  Condition: "http://snomed.info/sct",
  Observation: "http://loinc.org",
  MedicationRequest: "http://www.nlm.nih.gov/research/umls/rxnorm",
};

function codingsOf(resource) {
  if (resource.resourceType === "MedicationRequest") return resource.medicationCodeableConcept?.coding ?? [];
  return resource.code?.coding ?? [];
}

const source = process.argv[2];
if (!source) {
  console.error("Usage: node tools/synthea-subset.mjs <extracted-folder>");
  process.exit(2);
}

const files = (await readdir(source)).filter((f) => f.endsWith(".json")).sort();
const inventory = new Map();
const selected = [];
let patients = 0;
for (const file of files) {
  const bundle = JSON.parse(await readFile(path.join(source, file), "utf8"));
  if (bundle.resourceType !== "Bundle" || !bundle.entry?.some((e) => e.resource?.resourceType === "Patient")) continue;
  patients += 1;
  for (const { resource } of bundle.entry) {
    const system = SYSTEMS[resource.resourceType];
    if (!system) continue;
    for (const coding of codingsOf(resource)) {
      if (coding.system !== system) continue;
      const key = `${resource.resourceType}|${coding.code}`;
      const entry = inventory.get(key) ?? { resource: resource.resourceType, system, code: coding.code, display: coding.display, patients: new Set() };
      entry.patients.add(file);
      inventory.set(key, entry);
    }
  }
  const prefix = Object.keys(PATIENTS).find((p) => file.startsWith(`${p}_`));
  if (prefix) {
    selected.push({
      file,
      reason: PATIENTS[prefix],
      bundle: { ...bundle, entry: bundle.entry.filter((e) => KEEP.has(e.resource?.resourceType)) },
    });
  }
}

const missing = Object.keys(PATIENTS).filter((p) => !selected.some((s) => s.file.startsWith(`${p}_`)));
if (missing.length) {
  console.error(`Selected patients not found in ${source}: ${missing.join(", ")}`);
  process.exit(1);
}

await rm(path.join(OUT, "patients"), { recursive: true, force: true });
await mkdir(path.join(OUT, "patients"), { recursive: true });
for (const s of selected) {
  await writeFile(path.join(OUT, "patients", s.file), `${JSON.stringify(s.bundle)}\n`);
}
const codes = [...inventory.values()]
  .map((e) => ({ resource: e.resource, system: e.system, code: e.code, display: e.display, patients: e.patients.size }))
  .sort((a, b) => a.resource.localeCompare(b.resource) || b.patients - a.patients || a.code.localeCompare(b.code));
await writeFile(
  path.join(OUT, "code-inventory.json"),
  `${JSON.stringify({ sample: "synthea_sample_data_fhir_latest.zip", patients, codes }, null, 1)}\n`,
);
await writeFile(
  path.join(OUT, "patients", "index.json"),
  `${JSON.stringify(selected.map((s) => ({ file: s.file, reason: s.reason, resources: s.bundle.entry.length })), null, 2)}\n`,
);
console.log(`Inventory: ${codes.length} codes from ${patients} patients. Kept ${selected.length} trimmed patients.`);
