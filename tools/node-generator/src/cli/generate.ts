// pnpm gen: build every trial node into dist/nodes/<slug>/ from the stored data (offline).

import { rm } from "node:fs/promises";
import path from "node:path";
import { AREAS } from "../areas.ts";
import { generateNode } from "../generate.ts";
import { PATHS } from "../paths.ts";
import { generateShadyNode, SHADY_AREA } from "../shady.ts";

async function main(): Promise<void> {
  for (const area of AREAS) {
    const dir = await generateNode(area, PATHS.distNodes);
    console.log(`${area.slug}: ${path.relative(process.cwd(), dir)} (network ${area.network}, port ${area.port})`);
  }
  console.log(`Generated ${AREAS.length} nodes.`);
  // The DEMO / ADVERSARIAL node: only the demo config (config/nodes.demo.json) lists it. It is
  // written outside dist/nodes (and any copy an older gen left there is removed), so deploying
  // dist/nodes never ships it.
  await rm(path.join(PATHS.distNodes, SHADY_AREA.slug), { recursive: true, force: true });
  const shady = await generateShadyNode(PATHS.distDemoNodes);
  console.log(`${SHADY_AREA.slug}: ${path.relative(process.cwd(), shady)} (DEMO / ADVERSARIAL, network ${SHADY_AREA.network}, port ${SHADY_AREA.port})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
