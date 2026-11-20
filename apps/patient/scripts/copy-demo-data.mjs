// Copy the demo inputs into public/ (build time, same origin):
//   public/demo-patients/<id>.json + index.json   date-shifted Synthea bundles (data/synthea/shifted) picked by pnpm match:report
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const data = new URL("../../../data/", import.meta.url);
const pub = new URL("../public/", import.meta.url);

const demo = JSON.parse(await readFile(new URL("demo-patients.json", data), "utf8"));
const demoDir = new URL("demo-patients/", pub);
await rm(demoDir, { recursive: true, force: true });
await mkdir(demoDir, { recursive: true });
const index = [];
for (const p of demo.patients) {
  if (!/^[a-z0-9-]+$/.test(p.id) || p.file.includes("/")) throw new Error(`Unexpected demo patient entry ${p.id}`);
  await copyFile(new URL(`synthea/shifted/${p.file}`, data), new URL(`${p.id}.json`, demoDir));
  index.push({ id: p.id, area: p.area, label: `${p.area.replace(/-/g, " ")}: ${p.sex}, ${p.age ?? "age unknown"} (synthetic)`, file: `/demo-patients/${p.id}.json` });
}
await writeFile(new URL("index.json", demoDir), JSON.stringify(index, null, 2) + "\n");

console.log(`Demo data: ${index.length} patients -> ${fileURLToPath(demoDir)}`);
