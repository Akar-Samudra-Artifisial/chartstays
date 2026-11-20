// Week 6 local model, browser side: the model worker protocol (load, cancel, abort) with a fake
// worker, the cache state check with a fake Cache Storage, and the pins the sizes come from.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { cancelLocalModelLoad, LOCAL_MODELS, modelCacheState, startLocalModel, WebLlmWorker } from "../lib/webllm-client.ts";

const PINS = JSON.parse(await readFile(new URL("../public/webllm/pins.json", import.meta.url), "utf8"));
const MODEL = "Qwen3-1.7B-q4f16_1-MLC";

/** A fake Worker: records posted messages; `reply` plays the worker's answers. */
class FakeWorker {
  static instances = [];
  posted = [];
  terminated = false;
  #listeners = { message: [], error: [] };
  constructor() {
    FakeWorker.instances.push(this);
  }
  addEventListener(type, fn) {
    this.#listeners[type].push(fn);
  }
  postMessage(message) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data) {
    for (const fn of this.#listeners.message) fn({ data });
  }
  last(type) {
    return this.posted.filter((m) => m.type === type).at(-1);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function loaded() {
  const fake = new FakeWorker();
  const worker = new WebLlmWorker(fake);
  const progress = [];
  const loading = worker.load(MODEL, (p, text) => progress.push([p, text]));
  const { id } = fake.last("load");
  fake.reply({ type: "progress", progress: 0.5, text: "half" });
  fake.reply({ type: "loaded", id, modelId: MODEL, contextTokens: 8192 });
  await loading;
  return { fake, worker, progress };
}

test("load: progress is reported, the reply sets the model and context", async () => {
  const { fake, worker, progress } = await loaded();
  assert.deepEqual(fake.last("load"), { type: "load", modelId: MODEL, id: 1 });
  assert.deepEqual(progress, [[0.5, "half"]]);
  assert.equal(worker.modelId, MODEL);
  assert.equal(worker.contextTokens, 8192);
  await assert.rejects(new WebLlmWorker(new FakeWorker()).load("evil-model", () => {}), /Unknown local model/);
});

test("cancel during download: the pending load rejects, the worker stops, a new download can start", async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    FakeWorker.instances = [];
    const first = startLocalModel(MODEL, () => {});
    await tick();
    assert.equal(FakeWorker.instances.length, 1);
    assert.ok(FakeWorker.instances[0].last("load"));
    cancelLocalModelLoad();
    await assert.rejects(first, /The local model was stopped\./);
    assert.equal(FakeWorker.instances[0].terminated, true);

    const second = startLocalModel(MODEL, () => {});
    await tick();
    assert.equal(FakeWorker.instances.length, 2, "a fresh worker after the cancel");
    const fresh = FakeWorker.instances[1];
    fresh.reply({ type: "loaded", id: fresh.last("load").id, modelId: MODEL, contextTokens: 8192 });
    const engine = await second;
    assert.equal(engine.modelId, MODEL);
    cancelLocalModelLoad();
    assert.equal(fresh.terminated, true);
  } finally {
    globalThis.Worker = previous;
  }
});

test("a worker error reply rejects the load (no hang)", async () => {
  const fake = new FakeWorker();
  const worker = new WebLlmWorker(fake);
  const loading = worker.load(MODEL, () => {});
  fake.reply({ type: "error", id: fake.last("load").id, message: "Integrity check failed for https://huggingface.co/x." });
  await assert.rejects(loading, /Integrity check failed/);
  assert.equal(worker.modelId, "");
});

test("abort: an aborted signal never reaches the worker; aborting mid-reply tells the worker to stop", async () => {
  const { fake, worker } = await loaded();
  const done = new AbortController();
  done.abort();
  await assert.rejects(worker.complete([{ role: "user", content: "hi" }], { maxTokens: 64, signal: done.signal }), { name: "AbortError" });
  assert.equal(fake.last("chat"), undefined);

  const controller = new AbortController();
  const reply = worker.complete([{ role: "user", content: "hi" }], { maxTokens: 64, signal: controller.signal });
  await tick();
  const chat = fake.last("chat");
  assert.deepEqual(chat.messages, [{ role: "user", content: "hi" }]);
  controller.abort();
  assert.ok(fake.posted.some((m) => m.type === "abort"), "the worker is asked to interrupt generation");
  fake.reply({ type: "result", id: chat.id, text: "partial" });
  await assert.rejects(reply, { name: "AbortError" });

  // The worker still answers the next request.
  const next = worker.complete([{ role: "user", content: "again" }], { maxTokens: 64 });
  await tick();
  fake.reply({ type: "result", id: fake.last("chat").id, text: "ok" });
  assert.equal(await next, "ok");
});

test("structured: the worker gets the JSON schema only when one is given", async () => {
  const { fake, worker } = await loaded();
  assert.equal(worker.structured, true);
  const schema = JSON.stringify({ type: "object" });
  const reply = worker.complete([{ role: "user", content: "hi" }], { maxTokens: 64, jsonSchema: schema });
  await tick();
  assert.equal(fake.last("chat").jsonSchema, schema);
  fake.reply({ type: "result", id: fake.last("chat").id, text: '{"final":"ok"}' });
  assert.equal(await reply, '{"final":"ok"}');
  const plain = worker.complete([{ role: "user", content: "hi" }], { maxTokens: 64 });
  await tick();
  assert.equal("jsonSchema" in fake.last("chat"), false);
  fake.reply({ type: "result", id: fake.last("chat").id, text: "ok" });
  await plain;
});

/** A fake Cache Storage holding `urls` in webllm/model. */
function storage(urls) {
  return {
    has: async (name) => name === "webllm/model" && urls !== null,
    open: async () => ({ keys: async () => (urls ?? []).map((url) => ({ url })) }),
  };
}

test("model cache state: none, partial (some shards) and complete (manifest and every shard)", async () => {
  const pin = PINS.models[MODEL];
  const manifest = new URL("tensor-cache.json", pin.modelUrl).href;
  const shards = pin.shards.map((s) => new URL(s.path, pin.modelUrl).href);
  assert.equal(await modelCacheState(storage(null), pin), "none");
  assert.equal(await modelCacheState(storage([]), pin), "none");
  assert.equal(await modelCacheState(storage([manifest, ...shards.slice(0, 3)]), pin), "partial");
  assert.equal(await modelCacheState(storage(shards), pin), "partial", "without tensor-cache.json the model is not complete");
  assert.equal(await modelCacheState(storage([manifest, ...shards.slice(1)]), pin), "partial");
  assert.equal(await modelCacheState(storage([manifest, ...shards]), pin), "complete");
  // Another model's or another revision's files do not count.
  const other = shards.map((u) => u.replace(pin.commit, "0".repeat(40)));
  assert.equal(await modelCacheState(storage(other), pin), "none");
});

test("pins: every local model is pinned to a commit, and the shown size is the pinned download", () => {
  for (const m of LOCAL_MODELS) {
    const pin = PINS.models[m.id];
    assert.ok(pin, m.id);
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
    assert.equal(pin.modelUrl, `https://huggingface.co/${pin.repo}/resolve/${pin.commit}/`);
    assert.match(pin.wasm.commit, /^[0-9a-f]{40}$/);
    assert.equal(pin.wasm.path, `/webllm/libs/${pin.wasm.file}`);
    for (const sri of [pin.config.sri, pin.tokenizer.sri, pin.wasm.sri]) assert.match(sri, /^sha256-[A-Za-z0-9+/]{43}=$/);
    assert.ok(pin.shards.length > 0 && pin.shards.every((s) => /^[0-9a-f]{64}$/.test(s.sha256) && s.nbytes > 0));
    const total = pin.shards.reduce((n, s) => n + s.nbytes, 0) + pin.config.size + pin.tensorCache.size + pin.tokenizer.size + pin.wasm.size;
    assert.equal(pin.downloadBytes, total);
    assert.equal(m.downloadMB, Math.round(pin.downloadBytes / 1e6), `${m.id} downloadMB`);
  }
});
