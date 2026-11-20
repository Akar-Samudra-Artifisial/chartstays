// Fetch the WebGPU model libraries pinned in public/webllm/pins.json into public/webllm/libs/
// (gitignored), so the model worker loads them from our own origin. Every file is checked
// against its pinned sha256; a file already there with the right hash is not downloaded again.
// A hash mismatch fails the build. A network failure only warns: the site still builds offline,
// but the local model cannot start until the libraries are fetched (the worker verifies them too).
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webllmDir = fileURLToPath(new URL("../public/webllm/", import.meta.url));
const { models } = JSON.parse(await readFile(path.join(webllmDir, "pins.json"), "utf8"));
const libsDir = path.join(webllmDir, "libs");
await mkdir(libsDir, { recursive: true });

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

for (const [id, { wasm }] of Object.entries(models)) {
  if (!/^[\w.-]+\.wasm$/.test(wasm.file)) throw new Error(`${id}: bad library name ${wasm.file}.`);
  const target = path.join(libsDir, wasm.file);
  const existing = await readFile(target).catch(() => null);
  if (existing !== null && sha256Hex(existing) === wasm.sha256) {
    console.log(`${wasm.file}: present, sha256 ok`);
    continue;
  }
  let body;
  try {
    const res = await fetch(wasm.source);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    console.warn(`WARNING: could not fetch ${wasm.source} (${error.message}); the local model ${id} will not start until it is fetched.`);
    continue;
  }
  const actual = sha256Hex(body);
  if (actual !== wasm.sha256) throw new Error(`${wasm.file}: sha256 ${actual} does not match the pinned ${wasm.sha256}.`);
  await writeFile(`${target}.tmp`, body);
  await rename(`${target}.tmp`, target);
  console.log(`${wasm.file}: fetched ${body.length} bytes, sha256 ok`);
}
