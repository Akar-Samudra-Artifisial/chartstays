import path from "node:path";
import { fileURLToPath } from "node:url";

/** Monorepo root (tools/node-generator/src -> ../../..). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export const PATHS = {
  ctgov: path.join(REPO_ROOT, "data", "ctgov"),
  curated: path.join(REPO_ROOT, "data", "curated"),
  curation: path.join(REPO_ROOT, "data", "curation"),
  syntheaInventory: path.join(REPO_ROOT, "data", "synthea", "code-inventory.json"),
  syntheaPatients: path.join(REPO_ROOT, "data", "synthea", "patients"),
  /** Date-shifted copies of syntheaPatients (pnpm synthea:timeshift); used by the report, golden and demo. */
  syntheaShifted: path.join(REPO_ROOT, "data", "synthea", "shifted"),
  demoPatients: path.join(REPO_ROOT, "data", "demo-patients.json"),
  matchMatrix: path.join(REPO_ROOT, "docs", "match-matrix.md"),
  distNodes: path.join(REPO_ROOT, "dist", "nodes"),
  /** The DEMO / ADVERSARIAL node, kept out of dist/nodes so it is never deployed with the real nodes. */
  distDemoNodes: path.join(REPO_ROOT, "dist", "demo-nodes"),
  vendorSkill: path.join(REPO_ROOT, "vendor", "agentic-web", "skills", "agentify-website"),
  get vendorRuntime(): string {
    return path.join(this.vendorSkill, "runtime");
  },
  get buildNetwork(): string {
    return path.join(this.vendorSkill, "scripts", "build_network.mjs");
  },
};
