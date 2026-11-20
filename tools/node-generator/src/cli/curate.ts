// Write data/curated/<NCT>.criteria.json from snapshots and data/curation/<area>.json.
//
//   node src/cli/curate.ts                     curate every study of every area
//   node src/cli/curate.ts --print-lines NCT…  print the numbered eligibility lines of a study

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { hasNonAgeStructured, validateCriteria } from "@chartstays/criteria-schema";
import { AREAS } from "../areas.ts";
import { curate, loadCuration, loadSnapshot } from "../curate.ts";
import { splitEligibility } from "../eligibility.ts";
import { PATHS } from "../paths.ts";

async function printLines(nctId: string): Promise<void> {
  for (const area of AREAS) {
    const curation = await loadCuration(area.slug);
    if (!curation.studies.some((s) => s.nct_id === nctId)) continue;
    const e = (await loadSnapshot(area.slug, nctId)).study.protocolSection.eligibilityModule;
    console.log(`== ${nctId} (${area.slug}) age ${e.minimumAge ?? "-"}..${e.maximumAge ?? "-"} sex ${e.sex ?? "-"}`);
    for (const line of splitEligibility(e.eligibilityCriteria ?? "")) console.log(`${line.id}: ${line.text}`);
    return;
  }
  throw new Error(`${nctId} is not listed in any data/curation file`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { "print-lines": { type: "boolean" } },
    allowPositionals: true,
  });
  if (values["print-lines"]) {
    for (const id of positionals) await printLines(id);
    return;
  }
  await mkdir(PATHS.curated, { recursive: true });
  let failures = 0;
  let count = 0;
  for (const area of AREAS) {
    for (const study of (await loadCuration(area.slug)).studies) {
      const doc = curate(await loadSnapshot(area.slug, study.nct_id), study);
      const result = validateCriteria(doc);
      if (!result.valid) {
        failures += 1;
        console.error(`${study.nct_id}: ${result.errors.join("; ")}`);
        continue;
      }
      const kinds = doc.structured.map((c) => c.kind).join(",");
      const flag = hasNonAgeStructured(doc) ? "" : "  (no non-age criterion)";
      console.log(`${area.slug} ${doc.nct_id}: structured ${doc.structured.length} [${kinds}], free_text ${doc.free_text.length}${flag}`);
      await writeFile(path.join(PATHS.curated, `${doc.nct_id}.criteria.json`), `${JSON.stringify(doc, null, 2)}\n`);
      count += 1;
    }
  }
  console.log(`Curated ${count} studies.`);
  if (failures) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
