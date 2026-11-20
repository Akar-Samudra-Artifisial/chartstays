// Write data/synthea/shifted/: the Synthea subset with every date moved by a fixed offset per
// patient so the latest clinical date is TIMESHIFT_REFERENCE. data/synthea/patients is not changed.
//
//   node src/cli/timeshift.ts

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../paths.ts";
import { TIMESHIFT_REFERENCE, collectDates, timeshiftBundle, yearsBetween } from "../timeshift.ts";

interface IndexEntry {
  file: string;
  reason: string;
  resources: number;
}

async function main(): Promise<void> {
  const index = JSON.parse(await readFile(path.join(PATHS.syntheaPatients, "index.json"), "utf8")) as IndexEntry[];
  await rm(PATHS.syntheaShifted, { recursive: true, force: true });
  await mkdir(PATHS.syntheaShifted, { recursive: true });
  const out: (IndexEntry & { offset_days: number; original_latest: string })[] = [];
  for (const entry of index) {
    if (entry.file.includes("/") || !entry.file.endsWith(".json")) throw new Error(`Unexpected file name ${entry.file}`);
    const bundle = JSON.parse(await readFile(path.join(PATHS.syntheaPatients, entry.file), "utf8"));
    const { bundle: shifted, offsetDays, latest, shifted: count } = timeshiftBundle(bundle);
    const birth = collectDates(bundle).find(([key]) => key === "birthDate")?.[1];
    const newBirth = collectDates(shifted).find(([key]) => key === "birthDate")?.[1];
    if (birth !== undefined && newBirth !== undefined && yearsBetween(birth, latest) !== yearsBetween(newBirth, TIMESHIFT_REFERENCE)) {
      throw new Error(`${entry.file}: the shift changes the age at the latest date`);
    }
    await writeFile(path.join(PATHS.syntheaShifted, entry.file), JSON.stringify(shifted));
    out.push({ ...entry, offset_days: offsetDays, original_latest: latest });
    console.log(`${entry.file.split("_")[0]}: latest ${latest} -> ${TIMESHIFT_REFERENCE} (${offsetDays >= 0 ? "+" : ""}${offsetDays} days, ${count} dates)`);
  }
  await writeFile(path.join(PATHS.syntheaShifted, "index.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Shifted ${out.length} bundles -> ${PATHS.syntheaShifted}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
