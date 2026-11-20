// ChartStays' local model worker. Runs the pinned WebLLM bundle (web-llm.js, copied by
// scripts/vendor-webllm.mjs) off the main thread. The page never loads WebLLM itself; it talks
// to this worker with a small protocol:
//   in:  {type:"load", id, modelId} | {type:"chat", id, messages, maxTokens, jsonSchema?} | {type:"abort"}
//   out: {type:"progress", progress, text} | {type:"loaded", id, modelId, contextTokens}
//        | {type:"result", id, text} | {type:"error", id, message}
// Every model file is pinned in pins.json (scripts/pin-webllm.mjs): Hugging Face files by commit
// sha, the WebGPU library is served from our own origin (/webllm/libs/). Before WebLLM starts,
// this worker downloads tensor-cache.json and every weight shard itself, checks each against its
// pinned sha256 and only then puts it in WebLLM's cache. WebLLM checks the config, tokenizer and
// library against their pinned SRI hashes (ModelRecord.integrity). This worker's CSP (_headers,
// /webllm/*) lets it fetch only from our origin and Hugging Face. Patient data is only ever in
// `messages`, which stay here.
import { CreateMLCEngine } from "./web-llm.js";

/** The only models this worker loads. Keep in sync with lib/webllm-client.ts. */
const MODELS = new Set(["Qwen3-1.7B-q4f16_1-MLC", "Qwen3-4B-q4f16_1-MLC"]);
const CONTEXT_TOKENS = 8192;
/** Cache Storage scope WebLLM reads weights from (getTensorCacheAccessOptions("webllm/model")). */
const MODEL_CACHE = "webllm/model";
/** Share of the progress bar for the verified download; WebLLM's own loading gets the rest. */
const DOWNLOAD_SHARE = 0.85;
const PARALLEL_DOWNLOADS = 4;

let engine = null;
let loadedModel = "";
let pinsPromise = null;

function fail(id, error) {
  self.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
}

function progress(value, text) {
  self.postMessage({ type: "progress", progress: Math.max(0, Math.min(1, value)), text });
}

function loadPins() {
  pinsPromise ??= fetch("/webllm/pins.json").then((res) => {
    if (!res.ok) throw new Error(`Could not read the model pins (HTTP ${res.status}).`);
    return res.json();
  });
  return pinsPromise;
}

async function sha256Hex(buffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchVerified(url, sha256, nbytes) {
  const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Download failed: ${url} (HTTP ${res.status}).`);
  const buffer = await res.arrayBuffer();
  if (nbytes !== undefined && buffer.byteLength !== nbytes) throw new Error(`Size check failed for ${url}.`);
  if ((await sha256Hex(buffer)) !== sha256) throw new Error(`Integrity check failed for ${url}.`);
  return buffer;
}

function cachedResponse(buffer, type) {
  return new Response(buffer, { headers: { "Content-Type": type, "Content-Length": String(buffer.byteLength) } });
}

/**
 * Puts tensor-cache.json and all weight shards in WebLLM's cache, each checked against pins.json.
 * Shards already cached (from an earlier verified download) are kept when their size matches.
 */
async function prefetchWeights(pin) {
  const cache = await caches.open(MODEL_CACHE);
  const manifestUrl = new URL("tensor-cache.json", pin.modelUrl).href;
  let manifest = null;
  const cachedManifest = await cache.match(manifestUrl);
  if (cachedManifest !== undefined) {
    const buffer = await cachedManifest.arrayBuffer();
    if ((await sha256Hex(buffer)) === pin.tensorCache.sha256) manifest = buffer;
    else await cache.delete(manifestUrl);
  }
  if (manifest === null) {
    manifest = await fetchVerified(manifestUrl, pin.tensorCache.sha256, pin.tensorCache.size);
    await cache.put(manifestUrl, cachedResponse(manifest, "application/json"));
  }
  const records = JSON.parse(new TextDecoder().decode(manifest)).records;
  const expected = new Map(pin.shards.map((s) => [s.path, s]));
  if (records.length !== expected.size || records.some((r) => expected.get(r.dataPath)?.nbytes !== r.nbytes)) {
    throw new Error("The model's tensor-cache.json does not match the pinned shard list.");
  }

  const total = pin.shards.reduce((n, s) => n + s.nbytes, 0);
  let done = 0;
  const missing = [];
  for (const shard of pin.shards) {
    const url = new URL(shard.path, pin.modelUrl).href;
    const hit = await cache.match(url);
    if (hit !== undefined && (await hit.blob()).size === shard.nbytes) done += shard.nbytes;
    else missing.push({ ...shard, url });
  }
  const report = () =>
    progress((done / total) * DOWNLOAD_SHARE, `Downloading and verifying model files: ${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB`);
  report();
  let next = 0;
  const runner = async () => {
    while (next < missing.length) {
      const shard = missing[next++];
      const buffer = await fetchVerified(shard.url, shard.sha256, shard.nbytes);
      await cache.put(shard.url, cachedResponse(buffer, "application/octet-stream"));
      done += shard.nbytes;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_DOWNLOADS, missing.length) }, runner));
}

function modelRecord(modelId, pin) {
  return {
    model: pin.modelUrl,
    model_id: modelId,
    // Relative: WebLLM fetches it from our origin without its wasm cache, then checks integrity.
    model_lib: pin.wasm.path,
    vram_required_MB: pin.vramMB,
    low_resource_required: true,
    overrides: { context_window_size: CONTEXT_TOKENS },
    integrity: {
      config: pin.config.sri,
      model_lib: pin.wasm.sri,
      tokenizer: { "tokenizer.json": pin.tokenizer.sri },
      onFailure: "error",
    },
  };
}

async function load(id, modelId) {
  if (!MODELS.has(modelId)) return fail(id, `Model ${String(modelId).slice(0, 80)} is not allowed.`);
  if (engine !== null && loadedModel === modelId) {
    self.postMessage({ type: "loaded", id, modelId, contextTokens: CONTEXT_TOKENS });
    return;
  }
  if (engine !== null) {
    await engine.unload();
    engine = null;
    loadedModel = "";
  }
  const pin = (await loadPins()).models?.[modelId];
  if (pin === undefined || !pin.modelUrl.startsWith(`https://huggingface.co/${pin.repo}/resolve/${pin.commit}/`)) {
    return fail(id, `No valid pin for ${modelId}.`);
  }
  await prefetchWeights(pin);
  engine = await CreateMLCEngine(
    modelId,
    {
      appConfig: { cacheBackend: "cache", model_list: [modelRecord(modelId, pin)] },
      initProgressCallback: (report) => progress(DOWNLOAD_SHARE + (report.progress ?? 0) * (1 - DOWNLOAD_SHARE), report.text),
    },
    { context_window_size: CONTEXT_TOKENS },
  );
  loadedModel = modelId;
  self.postMessage({ type: "loaded", id, modelId, contextTokens: CONTEXT_TOKENS });
}

/** Longest JSON Schema accepted for a constrained reply (characters). */
const MAX_SCHEMA = 100_000;

async function chat(id, messages, maxTokens, jsonSchema) {
  if (engine === null) return fail(id, "The local model is not loaded.");
  if (!Array.isArray(messages) || messages.some((m) => !["system", "user", "assistant"].includes(m?.role) || typeof m.content !== "string")) {
    return fail(id, "Invalid messages.");
  }
  if (jsonSchema !== undefined && (typeof jsonSchema !== "string" || jsonSchema.length > MAX_SCHEMA)) return fail(id, "Invalid reply schema.");
  await engine.resetChat();
  const reply = await engine.chat.completions.create({
    messages,
    stream: false,
    // Greedy under a grammar: the same request picks the same tool every time.
    temperature: jsonSchema !== undefined ? 0 : 0.2,
    max_tokens: Number.isInteger(maxTokens) ? Math.min(maxTokens, 2048) : 1024,
    extra_body: { enable_thinking: false },
    // Grammar-constrained output (xgrammar): the reply is JSON that follows the schema.
    ...(jsonSchema !== undefined ? { response_format: { type: "json_object", schema: jsonSchema } } : {}),
  });
  self.postMessage({ type: "result", id, text: reply.choices[0]?.message?.content ?? "" });
}

self.addEventListener("message", (event) => {
  const msg = event.data ?? {};
  if (msg.type === "abort") {
    engine?.interruptGenerate();
    return;
  }
  const run = msg.type === "load" ? load(msg.id, msg.modelId) : msg.type === "chat" ? chat(msg.id, msg.messages, msg.maxTokens, msg.jsonSchema) : Promise.reject(new Error("Unknown request."));
  run.catch((error) => fail(msg.id, error));
});
