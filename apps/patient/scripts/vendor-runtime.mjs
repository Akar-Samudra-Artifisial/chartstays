// Copy the vendored agentic-web runtime, unchanged, into public/runtime/.
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../vendor/agentic-web/skills/agentify-website/runtime/", import.meta.url));
const target = fileURLToPath(new URL("../public/runtime/", import.meta.url));

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`Vendored runtime: ${source} -> ${target}`);
