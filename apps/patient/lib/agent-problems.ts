// What went wrong when the assistant asked other sites, in words shown on the page (not only in
// the console or the runtime's trace). The vendored runtime (public/runtime) reports these as
// trace events: a failed fetch-and-run of a peer network (remote_fetch: no network of the
// requested name, a network that fails validation, an origin outside allowed_peers), a failed
// tool or model call, a skipped call because a per-query budget ran out (composition_limit) and
// a skipped call to a network already in this request's chain (composition_skip: a cycle). The
// app's consent gate adds the nodes it refused (lib/runtime-consent.ts, trust log "blocked").

export interface AgentProblem {
  /** Stable kind for the page and the e2e (data-kind). */
  kind: "peer_failed" | "tool_failed" | "model_failed" | "budget" | "cycle" | "refused";
  /** The site involved, when known (host or origin). */
  where: string;
  message: string;
  /** The runtime's own error text, when there is one; a failed peer is reported by its fetch and its tool call with the same text. */
  error?: string;
}

/** The fields of a runtime trace event (public/runtime/trace.js) read here. */
export interface TraceEventLike {
  phase?: unknown;
  kind?: unknown;
  status?: unknown;
  error?: unknown;
  peerOrigin?: unknown;
  origin?: unknown;
  url?: unknown;
  tool?: unknown;
  target?: unknown;
  agent?: unknown;
  reason?: unknown;
  routerHost?: unknown;
}

/** The longest message shown (also the redaction limit used for it on the page). */
export const MAX_PROBLEM_MESSAGE = 400;
const MAX_MESSAGE = MAX_PROBLEM_MESSAGE;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: string): string {
  return value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE - 1)}…` : value;
}

/** The problem a trace event reports (message at most MAX_MESSAGE characters), or null for every other event. */
export function problemFromTrace(ev: TraceEventLike): AgentProblem | null {
  const problem = describe(ev);
  return problem === null ? null : { ...problem, message: clip(problem.message) };
}

function describe(ev: TraceEventLike): AgentProblem | null {
  const kind = text(ev.kind);
  if (ev.phase === "end" && ev.status === "error") {
    const error = clip(text(ev.error) || "unknown error");
    if (kind === "remote_fetch") return { kind: "peer_failed", where: text(ev.peerOrigin) || text(ev.url), message: `Could not use the network at ${text(ev.url) || text(ev.peerOrigin)}: ${error}`, error };
    if (kind === "tool") return { kind: "tool_failed", where: text(ev.origin), message: `The tool ${text(ev.tool) || "(unnamed)"} failed: ${error}`, error };
    if (kind === "model_call") return { kind: "model_failed", where: text(ev.routerHost), message: `The AI model call to ${text(ev.routerHost) || "the router"} failed: ${error}`, error };
    if (kind === "compile") return { kind: "peer_failed", where: text(ev.origin), message: `The assistant's network could not load: ${error}`, error };
    return null;
  }
  if (ev.phase === "note" && kind === "composition_limit") {
    const target = text(ev.target) || text(ev.agent) || "a call";
    return { kind: "budget", where: text(ev.origin), message: clip(`Skipped ${target}: ${text(ev.reason) || "a per-query limit was reached"}.`) };
  }
  if (ev.phase === "note" && kind === "composition_skip") {
    return { kind: "cycle", where: text(ev.origin), message: clip(`Skipped ${text(ev.target) || "a network"}: it is already in this request's call chain (a composition cycle).`) };
  }
  return null;
}

/** The fields of a trust log firewall entry (lib/trust-log.ts) read here. */
export interface FirewallEntryLike {
  type?: unknown;
  rule?: unknown;
  origin?: unknown;
  field?: unknown;
  snippet?: unknown;
}

/**
 * An agent's tool reference in a node's network JSON, as the firewall names the field
 * (lib/peer-fetch.ts inspects it as "network.json"), e.g. "network.json:tools[0].tools[0]".
 */
const FOREIGN_TOOL_FIELD = /^network(?:\.json)?:(?:.*\.)?tools\[\d+\]\.tools\[\d+\]$/;

/**
 * A node network handing off to a site outside the directory: the firewall removed that tool
 * reference (in.foreign-url) before the runtime saw it, so the site is never contacted. Null for
 * every other trust log entry, including links removed from ordinary node text.
 */
export function problemFromFirewall(entry: FirewallEntryLike | null | undefined): AgentProblem | null {
  if (entry?.type !== "firewall" || entry.rule !== "in.foreign-url" || !FOREIGN_TOOL_FIELD.test(text(entry.field))) return null;
  const where = text(entry.origin);
  const target = text(entry.snippet) || "a site outside the directory";
  return { kind: "refused", where, message: clip(`Refused to contact ${target} for ${where}: not a trial node in the directory (its link was removed before the network ran).`) };
}

/** Shown once per key: one runtime error text, or one budget / cycle message. */
export function problemKey(problem: AgentProblem): string {
  return problem.error !== undefined ? `error|${problem.error}` : `${problem.kind}|${problem.message}`;
}
