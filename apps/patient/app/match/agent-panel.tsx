"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_PROBLEM_MESSAGE, problemFromFirewall, problemFromTrace, problemKey, type AgentProblem, type TraceEventLike } from "../../lib/agent-problems";
import { allowedLinkOrigins, guardLinks, type LinkVerdict } from "../../lib/link-guard";
import { createActionGate, lockActionGate } from "../../lib/inquiry";
import { installPeerFetch } from "../../lib/peer-fetch";
import { createConsentGate, lockConsentGate } from "../../lib/runtime-consent";
import { llmDebugEnabled } from "../../lib/llm-debug";
import { createLocalRouter, LOCAL_ROUTER } from "../../lib/webllm-adapter";
import { activeLocalEngine } from "../../lib/webllm-client";
import { Icon, SectionHead } from "../icons";
import LocalModelPanel from "./local-model-panel";
import type { MatchApp } from "./match-app";

// Minimal shapes of the vendored runtime used here (public/runtime/index.js, engine.js, trace.js).
type TraceEvent = TraceEventLike & { phase: string; kind: string; routerHost?: string; mock?: boolean };
type RuntimeEngine = {
  onConsent: unknown;
  mockLLM: boolean;
  top: { llm: { baseUrl: string; mock: boolean } } | null;
};
type RuntimeTrace = EventTarget & { events: TraceEvent[] };
type RuntimeModule = {
  boot: (
    root: string,
    opts: { sandboxWorkerUrl: string; router?: string; byokKey?: string; model?: string },
  ) => Promise<{ engine: RuntimeEngine; trace: RuntimeTrace }>;
};
type BlockedLink = Extract<LinkVerdict, { allowed: false }>;

const RUNTIME_URL = "/runtime/index.js";
/** The runtime needs a non-empty key for a non-mock router; the local router ignores it. */
const LOCAL_KEY = "local-webllm";
const LOCAL_HOST = new URL(LOCAL_ROUTER).host;

declare global {
  // Read by public/site-actions.js when the runtime registers this site's actions.
  var __chartstaysSiteActions: unknown;
}

/** Longest debug text written to the console per entry (characters, after redaction). */
const DEBUG_MAX = 6_000;

/**
 * Prompt and raw replies to the console, through the health-data redaction first. Without the
 * profile's terms the redaction finds nothing, so then nothing is logged but the event name.
 */
function llmDebugSink(app: MatchApp): (event: string, text: string) => void {
  return (event, text) => {
    void (async () => {
      const terms = await app.terms().catch(() => null);
      if (terms === null) {
        console.debug(`[chartstays local LLM] ${event} (not shown: no imported record to redact with)`);
        return;
      }
      console.debug(`[chartstays local LLM] ${event}\n${await app.firewall.redactForLog(text, { max: DEBUG_MAX })}`);
    })();
  };
}

/** Tool names of this site's irreversible actions (website_prepareInquiry), for the local router. */
function irreversibleTools(app: MatchApp): string[] {
  return app.actions.filter((a) => a.effect === "irreversible").map((a) => `website_${a.name}`);
}

/** The agent chat: boots the in-browser runtime on request, with ChartStays' consent gate. */
export default function AgentPanel({ app, onStart }: { app: MatchApp; onStart?: () => void }) {
  const [state, setState] = useState<"idle" | "booting" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState<BlockedLink | null>(null);
  const [problems, setProblems] = useState<AgentProblem[]>([]);
  const booted = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [linkOrigins, setLinkOrigins] = useState<Set<string> | null>(null);
  const [mode, setMode] = useState<"demo" | "local">("demo");
  const [debugLlm, setDebugLlm] = useState(false);

  // Read after hydration (localStorage exists only in the browser).
  useEffect(() => setDebugLlm(llmDebugEnabled()), []);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null || linkOrigins === null) return;
    return guardLinks(root, linkOrigins, (verdict) => {
      app.log.record({ type: "link", origin: verdict.withoutQuery === null ? "(not a web link)" : new URL(verdict.url).origin, decision: "blocked" });
      setBlocked(verdict);
    });
  }, [app, linkOrigins]);

  /** `localModel`: boot with the in-page WebLLM router (browser://webllm) instead of the demo/BYOK one. */
  async function start(localModel?: string): Promise<void> {
    if (booted.current) return;
    booted.current = true;
    setState("booting");
    onStart?.();
    try {
      const directory = await app.directory();
      const origins = directory.map((e) => e.origin);
      setLinkOrigins(allowedLinkOrigins(window.location.origin, origins));
      // Before boot: the runtime's own requests to trial nodes go through the guard, and the
      // local router answers browser://webllm in the page (503 until a local model is loaded).
      installPeerFetch(window, {
        origins,
        log: app.log,
        firewall: app.firewall,
        localRouter: {
          prefix: LOCAL_ROUTER,
          handle: createLocalRouter(activeLocalEngine, { irreversible: irreversibleTools(app), ...(llmDebugEnabled() ? { debug: llmDebugSink(app) } : {}) }),
        },
      });
      // The runtime imports public/site-actions.js during boot; it registers these.
      globalThis.__chartstaysSiteActions = app.actions;
      const runtime = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ RUNTIME_URL)) as RuntimeModule;
      const opts = localModel === undefined ? {} : { router: LOCAL_ROUTER, byokKey: LOCAL_KEY, model: localModel };
      const { engine, trace } = await runtime.boot("#agent-app", { sandboxWorkerUrl: "/runtime/sandbox-worker.js", ...opts });
      lockConsentGate(engine, createConsentGate({ consent: app.consent, directory, log: app.log, terms: app.terms, firewall: app.firewall }));
      // prepareInquiry is the only irreversible action: the app's own dialog, never the runtime's.
      lockActionGate(engine, createActionGate({ desk: app.desk, session: app.session, log: app.log, origin: window.location.origin }));
      const llm = engine.top?.llm;
      let lastRouter = llm ? `${llm.baseUrl}|${llm.mock}` : "";
      const isLocal = (router: string) => router.startsWith(LOCAL_ROUTER) || router === LOCAL_HOST;
      if (llm) app.log.record({ type: "router", router: llm.baseUrl, mock: llm.mock, ...(isLocal(llm.baseUrl) ? { local: true } : {}) });
      const seen = new Set<string>();
      // Directory origins, hosts and network names are public: never redacted ("t2d_trials" stays as is).
      const publicIds = directory.flatMap((e) => [`${e.origin}/${e.network}`, e.origin, new URL(e.origin).host, e.network]);
      const report = (problem: AgentProblem): void => {
        const key = problemKey(problem);
        if (seen.has(key)) return;
        seen.add(key);
        // Runtime error texts can quote a request: shown and logged only after the health-data redaction.
        void app.firewall.redactForLog(problem.message, { keep: publicIds, max: MAX_PROBLEM_MESSAGE }).then((message) => {
          app.log.record({ type: "error", ...(problem.where !== "" ? { origin: problem.where } : {}), message });
          setProblems((list) => [...list, { ...problem, message }]);
        });
      };
      // Nodes the consent gate refused for the assistant (not in the directory, wrong network name, ...).
      app.log.subscribe((entry) => {
        if (entry?.type === "consent" && entry.via === "agent" && entry.decision === "blocked") {
          report({ kind: "refused", where: entry.origin, message: `Refused to contact ${entry.origin}${entry.network ? ` (network ${entry.network})` : ""}: ${entry.detail ?? "blocked"}` });
        }
        const removed = problemFromFirewall(entry);
        if (removed !== null) report(removed);
      });
      trace.addEventListener("event", (event) => {
        const ev = (event as CustomEvent<TraceEvent>).detail;
        const problem = problemFromTrace(ev);
        if (problem !== null) report(problem);
        if (ev.kind !== "model_call" || ev.phase !== "start") return;
        const key = `${ev.routerHost ?? ""}|${engine.mockLLM}`;
        if (key === lastRouter || ev.routerHost === undefined) return;
        lastRouter = key;
        app.log.record({ type: "router", router: ev.routerHost, mock: engine.mockLLM, ...(isLocal(ev.routerHost) ? { local: true } : {}) });
      });
      setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  function openWithoutQuery(link: BlockedLink): void {
    if (link.withoutQuery === null) return;
    app.log.record({ type: "link", origin: new URL(link.withoutQuery).origin, decision: "opened_without_query" });
    window.open(link.withoutQuery, "_blank", "noopener,noreferrer");
    setBlocked(null);
  }

  return (
    <section aria-labelledby="agent-heading" className="card">
      <SectionHead icon="chat" step={4} id="agent-heading" title="Ask the assistant">
        The assistant uses the same steps as the buttons above: it reads your record in this browser, asks before it contacts each trial site, and
        matches locally. Ask it to explain a result, prepare an inquiry or build the doctor sheet.
      </SectionHead>
      <fieldset id="agent-model-choice" className="model-choice" disabled={state !== "idle"}>
        <legend>Choose a model before you start</legend>
        <div className="choice-grid">
          <label className="choice">
            <input type="radio" name="agent-model" id="agent-model-demo" value="demo" checked={mode === "demo"} onChange={() => setMode("demo")} />
            <span className="choice-body">
              <strong className="choice-title">
                <Icon name="zap" />
                Demo model, or your own key
              </strong>
              <span className="choice-tags">
                <span className="tag tag-ok">Starts instantly</span>
                <span className="tag">Scripted mock in this browser</span>
                <span className="tag tag-warn">Own key: questions go to your provider</span>
              </span>
              <span className="choice-note">
                The demo model is scripted and runs in this browser: starts at once, no download, no AI provider. After you start, you can add your own AI
                provider key in the assistant&apos;s AI model settings (a key saved there earlier is used again); your questions then go to that provider.
              </span>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="agent-model" id="agent-model-local" value="local" checked={mode === "local"} onChange={() => setMode("local")} />
            <span className="choice-body">
              <strong className="choice-title">
                <Icon name="cpu" />
                Local (WebLLM, free, runs on your GPU)
              </strong>
              <span className="choice-tags">
                <span className="tag tag-ok">Questions stay on this device</span>
                <span className="tag">About 1 GB download, once</span>
                <span className="tag tag-warn">20 to 90 s per answer</span>
              </span>
              <span className="choice-note">
                Your questions stay on this device; nothing goes to an AI provider. The first time it downloads the model (about 1 GB for the recommended
                one) and keeps it in this browser; each answer can take 20 to 90 seconds.
              </span>
            </span>
          </label>
        </div>
      </fieldset>
      {mode === "local" && debugLlm ? (
        <p id="llm-debug-banner" role="status" className="notice">
          Debug LLM logging on: the local model&apos;s prompts and replies go to this browser&apos;s console, after the health-data redaction. Remove
          localStorage chartstays_debug_llm to turn it off.
        </p>
      ) : null}
      {mode === "local" ? <LocalModelPanel
          log={app.log}
          locked={state !== "idle"}
          onReady={(modelId) => void start(modelId)}
          redact={(text) => app.firewall.redactForLog(text)}
        /> : null}
      {mode === "demo" && (state === "idle" || state === "booting") ? (
        <button type="button" id="start-agent" onClick={() => void start()} disabled={state === "booting"}>
          {state === "booting" ? <span className="spinner spinner-on-accent" aria-hidden="true" /> : <Icon name="chat" />}
          {state === "booting" ? "Starting…" : "Start the assistant"}
        </button>
      ) : null}
      {mode === "local" && state === "ready" ? (
        <p className="muted" id="local-wait-note">
          Running on your GPU: an answer can take 20 to 90 seconds. For quicker answers, reload the page and choose the demo model or your own AI provider key.
        </p>
      ) : null}
      {state === "error" ? (
        <p role="alert" className="error">
          The assistant could not start: {error}
        </p>
      ) : null}
      {blocked !== null ? (
        <div id="link-blocked" role="alert" className="notice">
          <p>
            Blocked a link to a site outside ClinicalTrials.gov and the trial sites. Full address: <code id="link-blocked-url">{blocked.url}</code>
          </p>
          {blocked.withoutQuery !== null ? (
            <button type="button" id="link-open-without-query" onClick={() => openWithoutQuery(blocked)}>
              Open {blocked.withoutQuery} (without the query string)
            </button>
          ) : null}{" "}
          <button type="button" id="link-dismiss" className="secondary small" onClick={() => setBlocked(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <div id="agent-problems" role="alert" className="notice">
          <p>The assistant could not use every site it tried:</p>
          <ul>
            {problems.map((p) => (
              <li key={problemKey(p)} data-kind={p.kind} data-where={p.where}>
                {p.message}
              </li>
            ))}
          </ul>
          <button type="button" id="agent-problems-dismiss" className="secondary small" onClick={() => setProblems([])}>
            Dismiss
          </button>
        </div>
      ) : null}
      <div id="agent-app" ref={rootRef} data-state={state} className="agent-app" hidden={state === "idle"} />
    </section>
  );
}
