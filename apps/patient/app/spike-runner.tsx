"use client";

import { useEffect, useRef, useState } from "react";

// Minimal shapes of the vendored runtime that this spike touches (runtime/index.js, engine.js).
type ConsentDecision = "allow" | "always" | "decline";
type ConsentInfo = { kind: string; peerLabel: string; peerOrigin: string; requestText?: string };
type TraceEvent = { phase: string; kind: string; status?: string; peerOrigin?: string; error?: string; network?: string };
type RuntimeEngine = {
  onConsent: ((info: ConsentInfo) => Promise<ConsentDecision>) | null;
  runTurn: (text: string) => Promise<{ text: string }>;
  trace: EventTarget & { events: TraceEvent[] };
  mockLLM: boolean;
};
type RuntimeModule = {
  boot: (root: string, opts: { sandboxWorkerUrl: string }) => Promise<{ engine: RuntimeEngine }>;
};

// First local trial node (pnpm serve:nodes). Patient features land in week 3+.
const NODE_A = "http://localhost:4101";
const RUNTIME_URL = "/runtime/index.js";

type SpikeResult = {
  booted: boolean;
  consentCalls: ConsentInfo[];
  consentDecision: ConsentDecision | null;
  answer: string | null;
  peerTrace: TraceEvent[];
  criteriaFetch: { ok: boolean; status?: number; node?: string; studyCount?: number; error?: string } | null;
  error: string | null;
};

function decisionFromUrl(): ConsentDecision | null {
  const value = new URLSearchParams(window.location.search).get("consent");
  return value === "allow" || value === "always" || value === "decline" ? value : null;
}

export default function SpikeRunner() {
  const started = useRef(false);
  const [result, setResult] = useState<SpikeResult | null>(null);

  async function run() {
    const out: SpikeResult = {
      booted: false, consentCalls: [], consentDecision: null, answer: null,
      peerTrace: [], criteriaFetch: null, error: null,
    };
    try {
      // Load the runtime from public/runtime at request time; the bundler must not touch it.
      const runtime = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ RUNTIME_URL)) as RuntimeModule;
      const { engine } = await runtime.boot("#agent-app", { sandboxWorkerUrl: "/runtime/sandbox-worker.js" });
      out.booted = true;

      // Consent hook: replace the one mountApp installs (runtime/ui.js) with our own gate.
      engine.onConsent = async (info) => {
        out.consentCalls.push({ kind: info.kind, peerLabel: info.peerLabel, peerOrigin: info.peerOrigin, requestText: info.requestText });
        const decision = decisionFromUrl() ?? (window.confirm(`Contact ${info.peerLabel} (${info.peerOrigin})?`) ? "allow" : "decline");
        out.consentDecision = decision;
        return decision;
      };

      const turn = await engine.runTurn("Which type 2 diabetes trials are recruiting?");
      out.answer = turn.text.slice(0, 400);
      out.peerTrace = engine.trace.events
        .filter((event) => event.phase !== "update" && ["remote_fetch", "remote_call", "consent", "compile", "composition_limit"].includes(event.kind))
        .map((event) => ({ phase: event.phase, kind: event.kind, status: event.status, peerOrigin: event.peerOrigin, network: event.network, error: event.error }));

      if (out.consentDecision === "allow" || out.consentDecision === "always") {
        // Matcher input: the node's public criteria, fetched without credentials.
        const response = await fetch(`${NODE_A}/criteria/index.json`, { credentials: "omit", cache: "no-store" });
        if (response.ok) {
          const index = (await response.json()) as { node: string; studies: unknown[] };
          out.criteriaFetch = { ok: true, status: response.status, node: index.node, studyCount: index.studies.length };
        } else {
          out.criteriaFetch = { ok: false, status: response.status };
        }
      }
    } catch (error) {
      out.error = error instanceof Error ? error.message : String(error);
    }
    setResult(out);
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (new URLSearchParams(window.location.search).get("autorun") === "1") void run();
  }, []);

  return (
    <section>
      <button type="button" onClick={() => void run()}>Run spike</button>
      <div id="agent-app" style={{ height: 360, border: "1px solid #ccc", marginTop: 12 }} />
      <pre id="spike-result" data-done={result ? "1" : "0"}>{result ? JSON.stringify(result, null, 2) : "pending"}</pre>
    </section>
  );
}
