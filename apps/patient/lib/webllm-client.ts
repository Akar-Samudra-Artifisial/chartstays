// Browser side of the local model: WebGPU check, the model worker (public/webllm/worker.js),
// the model cache (Cache Storage, written by the worker and WebLLM inside it) and its deletion.
// The page never loads WebLLM itself; the worker does, under its own CSP (_headers /webllm/*).
// Every model file is pinned in public/webllm/pins.json (scripts/pin-webllm.mjs).
import type { LocalEngine, PromptMessage } from "./webllm-adapter.ts";

export interface LocalModelOption {
  id: string;
  label: string;
  /** Download size in MB (10^6 bytes): pinned weights, tokenizer, config and the WebGPU library. */
  downloadMB: number;
  /** GPU memory WebLLM lists for the model. */
  vramMB: number;
}

/** Keep in sync with MODELS in public/webllm/worker.js; downloadMB = pins.json downloadBytes / 1e6 (a test checks). */
export const LOCAL_MODELS: readonly LocalModelOption[] = [
  { id: "Qwen3-1.7B-q4f16_1-MLC", label: "Qwen3 1.7B (q4f16, recommended)", downloadMB: 986, vramMB: 2037 },
  { id: "Qwen3-4B-q4f16_1-MLC", label: "Qwen3 4B (q4f16, better, slower)", downloadMB: 2281, vramMB: 3432 },
];

export const WORKER_URL = "/webllm/worker.js";
export const PINS_URL = "/webllm/pins.json";
/** Cache Storage names WebLLM writes (cache scopes webllm/model, webllm/config, webllm/wasm). */
const CACHE_PREFIXES = ["webllm/", "tvmjs"];
/** IndexedDB names WebLLM uses with its IndexedDB cache backend (one database per cache scope). */
const INDEXED_DB_NAMES = ["webllm/model", "webllm/config", "webllm/wasm", "tvmjs"];
/** The Cache Storage scope holding tensor-cache.json and the weight shards. */
const MODEL_CACHE = "webllm/model";

/** The parts of a pins.json model entry the page needs. */
export interface ModelPin {
  modelUrl: string;
  shards: readonly { path: string; nbytes: number }[];
}

export function formatSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(mb >= 1950 ? 1 : 2)} GB` : `${mb} MB`;
}

export type WebGpuStatus = { supported: true; adapter: string } | { supported: false; reason: string };

type GpuAdapterInfo = { vendor?: string; architecture?: string; description?: string };
type GpuLike = { requestAdapter(): Promise<{ info?: GpuAdapterInfo } | null> };

/** Whether this browser can run the local model (WebGPU with an adapter). */
export async function checkWebGpu(): Promise<WebGpuStatus> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (gpu === undefined) return { supported: false, reason: "This browser has no WebGPU." };
  try {
    const adapter = await gpu.requestAdapter();
    if (adapter === null) return { supported: false, reason: "WebGPU is available but found no usable GPU adapter." };
    const info = adapter.info ?? {};
    return { supported: true, adapter: [info.vendor, info.architecture, info.description].filter((s) => s).join(" ") || "GPU" };
  } catch (error) {
    return { supported: false, reason: `WebGPU failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function isModelCacheName(name: string): boolean {
  return CACHE_PREFIXES.some((p) => name.startsWith(p));
}

let pinsPromise: Promise<Record<string, ModelPin>> | null = null;

function loadPins(): Promise<Record<string, ModelPin>> {
  pinsPromise ??= fetch(PINS_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ models: Record<string, ModelPin> }>;
    })
    .then((pins) => pins.models)
    .catch((error: unknown) => {
      pinsPromise = null;
      throw error;
    });
  return pinsPromise;
}

export type CacheState = "none" | "partial" | "complete";

/**
 * How much of a pinned model is in `storage`: "complete" only when tensor-cache.json and every
 * weight shard are cached (the worker stores a shard only after its sha256 matched).
 */
export async function modelCacheState(storage: Pick<CacheStorage, "has" | "open">, pin: ModelPin): Promise<CacheState> {
  if (!(await storage.has(MODEL_CACHE))) return "none";
  const cache = await storage.open(MODEL_CACHE);
  const keys = new Set((await cache.keys()).map((req) => req.url));
  const urls = [new URL("tensor-cache.json", pin.modelUrl).href, ...pin.shards.map((s) => new URL(s.path, pin.modelUrl).href)];
  const present = urls.filter((url) => keys.has(url)).length;
  return present === urls.length ? "complete" : present === 0 ? "none" : "partial";
}

/** Whether the model's weights are fully, partly or not at all in this browser's cache. */
export async function isModelCached(modelId: string): Promise<CacheState> {
  if (typeof caches === "undefined") return "none";
  try {
    const pin = (await loadPins())[modelId];
    return pin === undefined ? "none" : await modelCacheState(caches, pin);
  } catch {
    return "none";
  }
}

type WorkerReply =
  | { type: "progress"; progress: number; text: string }
  | { type: "loaded"; id: number; modelId: string; contextTokens: number }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id: number; message: string };

/** The parts of a Worker this class uses (a test passes a fake). */
export type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener">;

/** The model worker as a LocalEngine (lib/webllm-adapter.ts). One request at a time. */
export class WebLlmWorker implements LocalEngine {
  #worker: WorkerLike;
  #seq = 0;
  #pending = new Map<number, { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void }>();
  #onProgress: ((progress: number, text: string) => void) | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  modelId = "";
  contextTokens = 4096;
  /** The worker passes jsonSchema to WebLLM as response_format json_object (grammar-constrained). */
  readonly structured = true;

  constructor(worker: WorkerLike = new Worker(WORKER_URL, { type: "module", name: "chartstays-webllm" })) {
    this.#worker = worker;
    this.#worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === "progress") {
        this.#onProgress?.(reply.progress, reply.text);
        return;
      }
      const pending = this.#pending.get(reply.id);
      if (pending === undefined) return;
      this.#pending.delete(reply.id);
      if (reply.type === "error") pending.reject(new Error(reply.message));
      else pending.resolve(reply);
    });
    this.#worker.addEventListener("error", (event: ErrorEvent) => this.#failAll(new Error(`The local model worker failed: ${event.message || "unknown error"}`)));
  }

  #failAll(error: Error): void {
    for (const p of this.#pending.values()) p.reject(error);
    this.#pending.clear();
  }

  #request(message: Record<string, unknown>): Promise<WorkerReply> {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...message, id });
    });
  }

  /** Downloads (first time) and starts the model; reports progress between 0 and 1. */
  async load(modelId: string, onProgress: (progress: number, text: string) => void): Promise<void> {
    if (!LOCAL_MODELS.some((m) => m.id === modelId)) throw new Error(`Unknown local model ${modelId}.`);
    this.#onProgress = onProgress;
    try {
      const reply = await this.#request({ type: "load", modelId });
      if (reply.type !== "loaded") throw new Error("The local model worker gave an unexpected reply.");
      this.modelId = reply.modelId;
      this.contextTokens = reply.contextTokens;
    } finally {
      this.#onProgress = null;
    }
  }

  complete(messages: readonly PromptMessage[], options: { maxTokens: number; signal?: AbortSignal; jsonSchema?: string }): Promise<string> {
    const run = async () => {
      if (this.modelId === "") throw new Error("The local model is not loaded.");
      options.signal?.throwIfAborted();
      const abort = () => this.#worker.postMessage({ type: "abort" });
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const reply = await this.#request({
          type: "chat",
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          maxTokens: options.maxTokens,
          ...(options.jsonSchema !== undefined ? { jsonSchema: options.jsonSchema } : {}),
        });
        options.signal?.throwIfAborted();
        if (reply.type !== "result") throw new Error("The local model worker gave an unexpected reply.");
        return reply.text;
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    };
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  terminate(): void {
    this.#worker.terminate();
    this.#failAll(new Error("The local model was stopped."));
    this.modelId = "";
  }
}

let active: WebLlmWorker | null = null;

/** The loaded local model, or null (the local router then answers 503). */
export function activeLocalEngine(): LocalEngine | null {
  return active !== null && active.modelId !== "" ? active : null;
}

/** Starts (or reuses) the worker and loads `modelId`. */
export async function startLocalModel(modelId: string, onProgress: (progress: number, text: string) => void): Promise<LocalEngine> {
  const worker = (active ??= new WebLlmWorker());
  try {
    await worker.load(modelId, onProgress);
  } catch (error) {
    worker.terminate();
    if (active === worker) active = null;
    throw error;
  }
  return worker;
}

/**
 * Cancels a download or load in progress: stops the worker (the pending load rejects with "The
 * local model was stopped."). Shards already verified stay cached, so a new download resumes.
 */
export function cancelLocalModelLoad(): void {
  active?.terminate();
  active = null;
}

function deleteIndexedDb(factory: IDBFactory, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    // Another tab holds it open; the deletion completes when that tab closes it.
    req.onblocked = () => resolve(true);
  });
}

/**
 * Deletes WebLLM's IndexedDB databases (used by its IndexedDB cache backend, and the fallback when
 * Cache Storage is missing). Returns how many deletions were requested successfully.
 */
export async function deleteModelDatabases(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): Promise<number> {
  if (factory === undefined) return 0;
  const names = new Set(INDEXED_DB_NAMES);
  try {
    for (const db of (await factory.databases?.()) ?? []) {
      if (db.name !== undefined && isModelCacheName(db.name)) names.add(db.name);
    }
  } catch {
    // databases() is missing in some browsers; the fixed names are still deleted.
  }
  let deleted = 0;
  for (const name of names) if (await deleteIndexedDb(factory, name)) deleted += 1;
  return deleted;
}

/** Stops the worker and deletes every cached model file. Returns how many caches were deleted. */
export async function deleteModelCache(): Promise<number> {
  cancelLocalModelLoad();
  let deleted = 0;
  if (typeof caches !== "undefined") {
    for (const name of await caches.keys()) {
      if (isModelCacheName(name) && (await caches.delete(name))) deleted += 1;
    }
  }
  await deleteModelDatabases();
  return deleted;
}
