// Replaces the agent runtime's consent hook with ChartStays' own gate and locks it.
// The runtime (public/runtime/engine.js requestConsent) allows every peer call when no hook
// is set, and its default card offers "always"; this gate never allows by default, never
// answers "always", accepts only directory nodes asked for their own network, keeps the
// question short and blocks questions that carry health data (through the Agent Firewall).
import { PURPOSE_ASK, type ConsentManager } from "./consent.ts";
import { entryForPeer, networkFromPeerLabel, type DirectoryEntry } from "./directory.ts";
import { AgentFirewall } from "./firewall.ts";
import { MAX_REQUEST_TEXT } from "./firewall-rules.ts";
import type { ProfileTerms } from "./phi-scan.ts";
import type { TrustLog } from "./trust-log.ts";

export type RuntimeDecision = "allow" | "decline";

/** Longest question an agent may send to a node's assistant; the dialog shows all of it. */
export const MAX_PEER_REQUEST = MAX_REQUEST_TEXT;

export interface RuntimeConsentInfo {
  kind?: unknown;
  peerOrigin?: unknown;
  peerLabel?: unknown;
  requestText?: unknown;
}

export interface GateDeps {
  consent: ConsentManager;
  directory: readonly DirectoryEntry[];
  log: TrustLog;
  /** Terms from the current profile; null when no profile is imported. */
  terms: () => Promise<ProfileTerms | null>;
  /** The page's firewall; one using `terms` is created when absent. */
  firewall?: AgentFirewall;
}

export function createConsentGate(deps: GateDeps): (info: RuntimeConsentInfo) => Promise<RuntimeDecision> {
  const firewall = deps.firewall ?? new AgentFirewall({ log: deps.log, terms: deps.terms });
  return async (info) => {
    const peer = typeof info?.peerOrigin === "string" ? info.peerOrigin : "";
    const requestText = typeof info?.requestText === "string" ? info.requestText : "";
    const block = (origin: string, network: string, detail: string): RuntimeDecision => {
      deps.log.record({ type: "consent", origin: origin || "(unknown)", network, purpose: PURPOSE_ASK, decision: "blocked", via: "agent", detail });
      return "decline";
    };
    const entry = info?.kind === "network" ? entryForPeer(deps.directory, peer) : undefined;
    if (entry === undefined) return block(peer.slice(0, 200), "", "not a trial node in the directory");

    const requested = networkFromPeerLabel(info.peerLabel);
    if (requested !== entry.network) {
      return block(entry.origin, requested ?? "", `the requested network "${String(requested)}" is not the directory's network "${entry.network}"`);
    }
    // The Agent Firewall checks the question before anyone is asked: quarantined node, length
    // (MAX_PEER_REQUEST) and health data from the profile (failing closed). Each finding is logged.
    const out = await firewall.checkOutbound(entry.origin, "request_text", requestText);
    const [first] = out.findings;
    if (first !== undefined) {
      const detail =
        first.rule === "out.phi"
          ? "the question contained health data from the profile"
          : first.rule === "out.length"
            ? `the question is longer than ${MAX_PEER_REQUEST} characters (${requestText.length})`
            : first.reason;
      return block(entry.origin, entry.network, `${detail} [${first.rule}]`);
    }

    const allowed = await deps.consent.request(
      { origin: entry.origin, network: requested, label: entry.name, purpose: PURPOSE_ASK, requestText, ...(out.scan !== null ? { scan: out.scan } : {}) },
      "agent",
    );
    return allowed ? "allow" : "decline";
  };
}

/**
 * Install the gate on a booted engine and make the property read-only, so nothing that runs
 * later on the page (including the runtime's own UI) can swap in a default-allow hook.
 */
export function lockConsentGate(engine: object, gate: (info: RuntimeConsentInfo) => Promise<RuntimeDecision>): void {
  Object.defineProperty(engine, "onConsent", { value: gate, writable: false, configurable: false, enumerable: true });
  if ((engine as { onConsent?: unknown }).onConsent !== gate) throw new Error("Could not install the consent gate.");
}
