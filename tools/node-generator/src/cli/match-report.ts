// pnpm match:report: evaluate every Synthea subset patient against every curated study.
// Writes docs/match-matrix.md and data/demo-patients.json (offline, deterministic).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAreas, loadRows, pickHeroes, renderMarkdown, REPORT_AS_OF } from "../match-report.ts";
import { PATHS, REPO_ROOT } from "../paths.ts";

async function main(): Promise<void> {
  const areas = await loadAreas();
  const rows = await loadRows(areas, REPORT_AS_OF);
  const heroes = pickHeroes(areas, rows);

  await mkdir(path.dirname(PATHS.matchMatrix), { recursive: true });
  await writeFile(PATHS.matchMatrix, renderMarkdown(REPORT_AS_OF, areas, rows, heroes));
  const demo = {
    asOf: REPORT_AS_OF,
    generated_by: "pnpm match:report",
    note: "Synthetic Synthea patients from data/synthea/shifted (dates shifted so the latest record date is recent). One demo patient per area, picked by tier mix; see docs/match-matrix.md.",
    patients: heroes,
  };
  await writeFile(PATHS.demoPatients, JSON.stringify(demo, null, 2) + "\n");

  const totals = { strong_match: 0, possible_match: 0, not_eligible: 0 };
  for (const row of rows) for (const r of row.results.values()) totals[r.verdict] += 1;
  console.log(`${rows.length} patients x ${rows[0]?.results.size ?? 0} studies: ${JSON.stringify(totals)}`);
  for (const h of heroes) console.log(`${h.area}: ${h.short} (S${h.strong_match.length} P${h.possible_match.length} N${h.not_eligible.length})`);
  console.log(`Wrote ${path.relative(REPO_ROOT, PATHS.matchMatrix)} and ${path.relative(REPO_ROOT, PATHS.demoPatients)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
