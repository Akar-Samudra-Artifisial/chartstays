// Per-origin consent before any contact with a trial node. One prompt at a time; "Allow for
// this session" is remembered in memory for this page only and can be revoked per origin.
// Without a prompt (no dialog mounted) every request is denied: nothing ever defaults to allow.
import type { PhiScan } from "./phi-scan.ts";
import type { ConsentDecision, TrustLog } from "./trust-log.ts";

export interface ConsentRequest {
  /** Exact origin, e.g. http://localhost:4101. */
  origin: string;
  /** The network name the caller asked for (checked against the directory before this). */
  network: string;
  /** Human-readable node name from the directory. */
  label: string;
  /** What the contact is for, shown in the dialog. */
  purpose: string;
  /** For agent calls: the full text the agent wants to send to the node's assistant. */
  requestText?: string;
  /** The firewall's health-data scan of requestText, shown highlighted in the dialog. */
  scan?: PhiScan;
}

export type ConsentPrompt = (request: ConsentRequest) => Promise<ConsentDecision>;

export const PURPOSE_LOAD = "Load public trial criteria; no health data is sent.";
export const PURPOSE_ASK = "Run this node's public assistant in your browser to answer a question; no health data is sent.";

const DECISIONS: readonly string[] = ["allow_once", "allow_session", "deny"];

export class ConsentManager {
  #prompt: ConsentPrompt | null = null;
  #session = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #log: TrustLog;
  #listeners = new Set<() => void>();

  constructor(log: TrustLog) {
    this.#log = log;
  }

  setPrompt(prompt: ConsentPrompt | null): void {
    this.#prompt = prompt;
  }

  hasSessionAllow(origin: string): boolean {
    return this.#session.has(origin);
  }

  /** Origins with an active "Allow for this session". */
  sessionOrigins(): string[] {
    return [...this.#session];
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not affect consent.
      }
    }
  }

  /** Forget the "Allow for this session" decision for one origin; the next contact asks again. */
  revoke(origin: string, network = ""): boolean {
    if (!this.#session.delete(origin)) return false;
    this.#log.record({ type: "consent", origin, network, purpose: "", decision: "revoked", via: "user" });
    this.#changed();
    return true;
  }

  /** Forget every "Allow for this session" decision. */
  revokeAll(): void {
    for (const origin of [...this.#session]) this.revoke(origin);
  }

  /**
   * Ask (or answer from the session) whether `request.origin` may be contacted.
   * Resolves true only on an explicit allow; errors and a missing prompt deny.
   */
  request(request: ConsentRequest, via: "find" | "agent"): Promise<boolean> {
    const decide = async (): Promise<boolean> => {
      const base = {
        origin: request.origin,
        network: request.network,
        purpose: request.purpose,
        via,
        ...(request.requestText !== undefined ? { requestText: request.requestText } : {}),
        ...(request.scan !== undefined ? { phiFields: request.scan.spans.length } : {}),
      } as const;
      if (this.#session.has(request.origin)) {
        this.#log.record({ type: "consent", ...base, decision: "remembered" });
        return true;
      }
      const prompt = this.#prompt;
      if (prompt === null) {
        this.#log.record({ type: "consent", ...base, decision: "deny", detail: "no consent dialog available" });
        return false;
      }
      let decision: ConsentDecision;
      try {
        const answer: unknown = await prompt(request);
        decision = typeof answer === "string" && DECISIONS.includes(answer) ? (answer as ConsentDecision) : "deny";
      } catch {
        decision = "deny";
      }
      if (decision === "allow_session") this.#session.add(request.origin);
      this.#log.record({ type: "consent", ...base, decision });
      if (decision === "allow_session") this.#changed();
      return decision !== "deny";
    };
    const pending = this.#tail.then(decide, decide);
    this.#tail = pending.catch(() => undefined);
    return pending;
  }
}
