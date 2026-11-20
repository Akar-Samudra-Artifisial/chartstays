"use client";

import { useEffect, useRef, useState } from "react";
import {
  cancelLocalModelLoad,
  checkWebGpu,
  deleteModelCache,
  formatSize,
  isModelCached,
  LOCAL_MODELS,
  startLocalModel,
  type CacheState,
  type WebGpuStatus,
} from "../../lib/webllm-client";
import type { TrustLog } from "../../lib/trust-log";

type Phase = "choose" | "confirm" | "loading" | "ready" | "error";

/** The status line read out by screen readers when the phase changes (progress is not repeated). */
function statusText(phase: Phase, label: string, message: string): string {
  if (phase === "confirm") return `Confirm the download of ${label}.`;
  if (phase === "loading") return `Downloading and starting ${label}. You can cancel.`;
  if (phase === "ready") return `${label} is loaded and runs on your GPU.`;
  if (phase === "error") return `The local model could not load: ${message}`;
  return message;
}

/**
 * The free local model: checks WebGPU, shows the download size, asks before downloading (also
 * when only part of it is cached), shows progress with a Cancel button and can delete the cached
 * model. The model runs in a Web Worker; health data stays in this browser (the only downloads
 * are the pinned model files from Hugging Face; the GPU library comes from this site).
 * `redact` censors text for the trust log (Firewall.redactForLog).
 */
export default function LocalModelPanel({
  log,
  locked,
  onReady,
  redact,
}: {
  log: TrustLog;
  locked: boolean;
  onReady: (modelId: string) => void;
  redact: (text: string) => Promise<string>;
}) {
  const [gpu, setGpu] = useState<WebGpuStatus | null>(null);
  const [modelId, setModelId] = useState(LOCAL_MODELS[0].id);
  const [cached, setCached] = useState<CacheState>("none");
  const [phase, setPhase] = useState<Phase>("choose");
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [message, setMessage] = useState("");
  const cancelled = useRef(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const lastPhase = useRef<Phase>("choose");

  useEffect(() => {
    let live = true;
    void checkWebGpu().then((status) => {
      if (live) setGpu(status);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void isModelCached(modelId).then((value) => {
      if (live) setCached(value);
    });
    return () => {
      live = false;
    };
  }, [modelId, phase]);

  // Focus follows the phase: the confirmation, the Cancel button while loading, then the result.
  useEffect(() => {
    if (lastPhase.current === phase) return;
    lastPhase.current = phase;
    if (phase === "confirm") confirmRef.current?.focus();
    else if (phase === "loading") cancelRef.current?.focus();
    else if (phase === "ready" || phase === "error") statusRef.current?.focus();
    else downloadRef.current?.focus();
  }, [phase]);

  const model = LOCAL_MODELS.find((m) => m.id === modelId) ?? LOCAL_MODELS[0];

  async function load(): Promise<void> {
    if (cached !== "complete") log.record({ type: "local_model", action: "download_confirmed", model: model.id });
    cancelled.current = false;
    setPhase("loading");
    setProgress(0);
    setProgressText("");
    setMessage("");
    try {
      await startLocalModel(model.id, (value, text) => {
        setProgress(value);
        setProgressText(text);
      });
      log.record({ type: "local_model", action: "loaded", model: model.id });
      setPhase("ready");
      onReady(model.id);
    } catch (error) {
      if (cancelled.current) return;
      const detail = error instanceof Error ? error.message : String(error);
      log.record({ type: "local_model", action: "load_failed", model: model.id, detail: await redact(detail.slice(0, 200)) });
      setMessage(detail);
      setPhase("error");
    }
  }

  function cancel(): void {
    cancelled.current = true;
    cancelLocalModelLoad();
    log.record({ type: "local_model", action: "load_failed", model: model.id, detail: "cancelled by the user" });
    setMessage("The download was cancelled. Files already checked stay in this browser, so downloading again continues from there.");
    setPhase("choose");
  }

  async function remove(): Promise<void> {
    const deleted = await deleteModelCache();
    log.record({ type: "local_model", action: "cache_deleted", detail: `${deleted} caches` });
    setMessage(
      deleted > 0
        ? "The downloaded model was deleted from this browser. To use the local model again, download it again."
        : "No downloaded model was found in this browser.",
    );
    setPhase("choose");
    setCached("none");
  }

  if (gpu === null) return <p className="muted" id="webllm-checking">Checking whether this browser supports WebGPU…</p>;
  if (!gpu.supported) {
    return (
      <div id="webllm-unsupported" role="status" className="notice">
        <p>
          The local model needs WebGPU, which is not available here: {gpu.reason} Use the demo model or your own key instead; matching still runs in this
          browser either way.
        </p>
        <button type="button" id="webllm-delete" className="secondary small" onClick={() => void remove()}>
          Delete downloaded model files
        </button>
        {message !== "" ? <p className="muted">{message}</p> : null}
      </div>
    );
  }

  const busy = phase === "loading" || locked;
  const sizeText = cached === "partial" ? `up to ${formatSize(model.downloadMB)} (part of it is already in this browser)` : `about ${formatSize(model.downloadMB)}`;
  return (
    <div id="webllm-panel" className="webllm-panel">
      <p className="muted">GPU: {gpu.adapter}. The model runs in a background worker in this tab and needs no key or account.</p>
      <label htmlFor="webllm-model" className="field-label">
        Local model
      </label>
      <select id="webllm-model" value={modelId} disabled={busy || phase === "ready"} onChange={(e) => setModelId(e.target.value)}>
        {LOCAL_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}: {formatSize(m.downloadMB)} download, about {formatSize(m.vramMB)} GPU memory
          </option>
        ))}
      </select>
      {phase === "choose" || phase === "error" ? (
        <p>
          <button
            type="button"
            id="webllm-download"
            ref={downloadRef}
            disabled={busy}
            data-cache={cached}
            onClick={() => (cached === "complete" ? void load() : setPhase("confirm"))}
          >
            {cached === "complete" ? "Load the downloaded model" : cached === "partial" ? `Resume download (${formatSize(model.downloadMB)})` : `Download ${formatSize(model.downloadMB)}`}
          </button>
        </p>
      ) : null}
      {phase === "confirm" ? (
        <div id="webllm-confirm" role="group" aria-label="Confirm the download" className="notice" tabIndex={-1} ref={confirmRef}>
          <p>
            Download {model.label}, {sizeText}, from huggingface.co (model weights, pinned to a fixed version and checked against their published
            hashes)? The GPU library comes from this site. It is stored in this browser for next time. Only model files are downloaded; nothing from your
            record is sent.
          </p>
          <button type="button" id="webllm-confirm-yes" onClick={() => void load()}>
            Download
          </button>{" "}
          <button type="button" id="webllm-confirm-no" className="secondary" onClick={() => setPhase("choose")}>
            Cancel
          </button>
        </div>
      ) : null}
      {phase === "loading" ? (
        <p>
          <progress id="webllm-progress" max={1} value={progress} aria-label={`Download of ${model.label}`} /> {Math.round(progress * 100)}%{" "}
          <span className="muted">{progressText}</span>{" "}
          <button type="button" id="webllm-cancel" className="secondary small" ref={cancelRef} onClick={cancel}>
            Cancel download
          </button>
        </p>
      ) : null}
      {/* One persistent live region for phase changes; it exists before its text changes. */}
      <p role="status" id="webllm-status" ref={statusRef} tabIndex={-1} className={phase === "error" ? "error" : "muted"} data-phase={phase}>
        {statusText(phase, model.label, message)}
      </p>
      <p>
        <button type="button" id="webllm-delete" className="secondary small" disabled={busy} aria-describedby={locked ? "webllm-delete-locked" : undefined} onClick={() => void remove()}>
          Delete downloaded model files
        </button>
        {locked ? (
          <span id="webllm-delete-locked" className="muted">
            {" "}
            The assistant is using the local model. Reload this page to stop it, then delete the files here.
          </span>
        ) : null}
      </p>
    </div>
  );
}
