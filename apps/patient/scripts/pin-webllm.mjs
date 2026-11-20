// Pin the local models to exact upstream commits and record the hash of every file the model
// worker downloads, in public/webllm/pins.json (small, committed). Run by hand when moving to a
// newer model revision:  node scripts/pin-webllm.mjs
// Sources: the Hugging Face model API (commit sha, file tree with LFS sha256) and the GitHub
// commits API for mlc-ai/binary-mlc-llm-libs (commit of each WebGPU model library). Files that
// are not LFS objects (config, tensor-cache.json) and the WASM libraries are downloaded once
// here and hashed. Nothing in this file is typed in by hand.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** WASM names come from prebuiltAppConfig in @mlc-ai/web-llm 0.2.88 (modelVersion v0_2_87/base). */
const MODELS = [
  { id: "Qwen3-1.7B-q4f16_1-MLC", repo: "mlc-ai/Qwen3-1.7B-q4f16_1-MLC", wasm: "Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm", vramMB: 2036.66 },
  { id: "Qwen3-4B-q4f16_1-MLC", repo: "mlc-ai/Qwen3-4B-q4f16_1-MLC", wasm: "Qwen3-4B-q4f16_1_cs1k-webgpu.wasm", vramMB: 3431.59 },
];
const LIBS_REPO = "mlc-ai/binary-mlc-llm-libs";
const LIBS_DIR = "web-llm-models/v0_2_87/base";
const OUT = fileURLToPath(new URL("../public/webllm/pins.json", import.meta.url));

async function get(url, as) {
  const res = await fetch(url, { headers: { "User-Agent": "chartstays-pin-script" } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return as === "json" ? res.json() : Buffer.from(await res.arrayBuffer());
}

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const sri = (hex) => `sha256-${Buffer.from(hex, "hex").toString("base64")}`;

async function pinModel(model) {
  const info = await get(`https://huggingface.co/api/models/${model.repo}`, "json");
  const commit = info.sha;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${model.repo}: no commit sha in the model API.`);
  const tree = await get(`https://huggingface.co/api/models/${model.repo}/tree/${commit}`, "json");
  const files = new Map(tree.map((f) => [f.path, f]));
  const base = `https://huggingface.co/${model.repo}/resolve/${commit}/`;

  const config = await get(`${base}mlc-chat-config.json`);
  if (!JSON.parse(config.toString("utf8")).tokenizer_files.includes("tokenizer.json")) {
    throw new Error(`${model.repo}: expected tokenizer.json among tokenizer_files.`);
  }
  const tensorCache = await get(`${base}tensor-cache.json`);
  const tokenizer = files.get("tokenizer.json");
  if (tokenizer?.lfs?.oid === undefined) throw new Error(`${model.repo}: tokenizer.json is not an LFS file.`);

  const shards = JSON.parse(tensorCache.toString("utf8")).records.map((record) => {
    const file = files.get(record.dataPath);
    if (file?.lfs?.oid === undefined || file.size !== record.nbytes) {
      throw new Error(`${model.repo}: ${record.dataPath} missing from the tree or size differs.`);
    }
    return { path: record.dataPath, nbytes: record.nbytes, sha256: file.lfs.oid };
  });

  const wasmPath = `${LIBS_DIR}/${model.wasm}`;
  const commits = await get(`https://api.github.com/repos/${LIBS_REPO}/commits?path=${encodeURIComponent(wasmPath)}&per_page=1`, "json");
  const wasmCommit = commits[0]?.sha;
  if (!/^[0-9a-f]{40}$/.test(wasmCommit ?? "")) throw new Error(`${wasmPath}: no commit in the GitHub API.`);
  const wasmSource = `https://raw.githubusercontent.com/${LIBS_REPO}/${wasmCommit}/${wasmPath}`;
  const wasm = await get(wasmSource);

  const downloadBytes = shards.reduce((n, s) => n + s.nbytes, 0) + config.length + tensorCache.length + tokenizer.size + wasm.length;
  return {
    repo: model.repo,
    commit,
    modelUrl: base,
    vramMB: model.vramMB,
    config: { size: config.length, sha256: sha256Hex(config), sri: sri(sha256Hex(config)) },
    tensorCache: { size: tensorCache.length, sha256: sha256Hex(tensorCache) },
    tokenizer: { size: tokenizer.size, sha256: tokenizer.lfs.oid, sri: sri(tokenizer.lfs.oid) },
    shards,
    wasm: { file: model.wasm, path: `/webllm/libs/${model.wasm}`, source: wasmSource, commit: wasmCommit, size: wasm.length, sha256: sha256Hex(wasm), sri: sri(sha256Hex(wasm)) },
    downloadBytes,
  };
}

const models = {};
for (const model of MODELS) models[model.id] = await pinModel(model);
await writeFile(OUT, `${JSON.stringify({ webllm: "0.2.88", pinnedAt: new Date().toISOString().slice(0, 10), models }, null, 2)}\n`);
for (const [id, m] of Object.entries(models)) console.log(`${id}: hf ${m.commit}, wasm ${m.wasm.commit}, ${m.shards.length} shards, ${m.downloadBytes} bytes`);
