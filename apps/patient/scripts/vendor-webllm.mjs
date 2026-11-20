// Copy the pinned WebLLM bundle (@mlc-ai/web-llm, exact version in package.json) into
// public/webllm/, next to our own worker (public/webllm/worker.js). The bundle is self-contained
// (no bare imports, eval or dynamic import) and only ever runs inside that worker.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("@mlc-ai/web-llm/package.json"));
const { version } = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
const target = fileURLToPath(new URL("../public/webllm/", import.meta.url));

await mkdir(target, { recursive: true });
await copyFile(path.join(pkgDir, "lib/index.js"), path.join(target, "web-llm.js"));
await copyFile(path.join(pkgDir, "LICENSE"), path.join(target, "web-llm.LICENSE.txt"));
console.log(`Vendored @mlc-ai/web-llm ${version} -> ${target}`);
