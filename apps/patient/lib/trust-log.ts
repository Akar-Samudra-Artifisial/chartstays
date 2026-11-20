// In-page record of every trust decision: origins contacted, consent decisions, tool calls and
// the LLM router. The full trust panel arrives later; this log is its data source. It lives in
// memory only and holds no patient data (tool arguments are not copied, only names). The one
// exception is `requestText`: the question an agent sends to a node's assistant, recorded after
// the health-data check passed, so the patient can see every text that left the page.

import type { PhiSegment } from "./phi-scan.ts";

export type ConsentDecision = "allow_once" | "allow_session" | "deny";
export type FirewallAction = "blocked" | "neutralized" | "quarantined";

export type TrustEventBody =
  | {
      type: "consent";
      origin: string;
      network: string;
      purpose: string;
      decision: ConsentDecision | "remembered" | "blocked" | "revoked";
      via: "find" | "agent" | "user";
      detail?: string;
      requestText?: string;
      /** Patient fields the health-data scan found in requestText (0 for anything sent). */
      phiFields?: number;
    }
  | {
      type: "contact";
      origin: string;
      path: string;
      status: "ok" | "error";
      detail?: string;
      /** Bytes received. */
      bytes?: number;
      /** Patient fields the health-data scan found in the request URL (0 for anything sent). */
      phiFields?: number;
      /** The request's query string, censored (health-data values replaced by their kind), when it had one. */
      query?: string;
      /** Length of the query string as sent. */
      queryLength?: number;
    }
  | {
      /** A firewall decision (lib/firewall.ts). Outbound text appears only redacted. */
      type: "firewall";
      origin: string;
      direction: "inbound" | "outbound";
      rule: string;
      action: FirewallAction;
      reason: string;
      field?: string;
      snippet?: string;
      redacted?: PhiSegment[];
    }
  | { type: "tool_call"; tool: string; status: "start" | "ok" | "error"; detail?: string }
  /** `local`: the in-page model (WebLLM); nothing is sent to a provider. */
  | { type: "router"; router: string; mock: boolean; local?: boolean }
  /**
   * The local model: downloads of model files and cache deletion (no patient data involved).
   * `detail` of a failure comes from the worker and is passed through Firewall.redactForLog first.
   */
  | { type: "local_model"; action: "download_confirmed" | "loaded" | "load_failed" | "cache_deleted"; model?: string; detail?: string }
  /**
   * prepareInquiry: names of the fields the patient chose and how many health-data spans the
   * scanner found in the draft, never the values. The draft is only copied or downloaded.
   */
  | {
      type: "inquiry";
      nct_id: string;
      via: "agent" | "user";
      action: "opened" | "prepared" | "cancelled" | "refused" | "copied" | "downloaded";
      fields?: string[];
      phiFields?: number;
      detail?: string;
    }
  | { type: "doctor_sheet"; action: "built" | "printed" | "downloaded"; via: "agent" | "user"; studies: number }
  | { type: "link"; origin: string; decision: "blocked" | "opened_without_query" }
  | { type: "error"; origin?: string; message: string };

export type TrustEvent = TrustEventBody & { seq: number; at: number };

/** Called with each new event, and with null when the log is cleared. */
export type TrustListener = (event: TrustEvent | null) => void;

/** Oldest events are dropped beyond this many, so a long session stays bounded. */
export const MAX_TRUST_EVENTS = 500;

export class TrustLog {
  #events: TrustEvent[] = [];
  #listeners = new Set<TrustListener>();
  #seq = 0;
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(body: TrustEventBody): TrustEvent {
    const event = { ...body, seq: ++this.#seq, at: this.#now() } as TrustEvent;
    this.#events.push(event);
    if (this.#events.length > MAX_TRUST_EVENTS) this.#events.splice(0, this.#events.length - MAX_TRUST_EVENTS);
    this.#notify(event);
    return event;
  }

  /** Forget every event ("Delete my data"). */
  clear(): void {
    this.#events = [];
    this.#notify(null);
  }

  #notify(event: TrustEvent | null): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop recording.
      }
    }
  }

  events(): readonly TrustEvent[] {
    return [...this.#events];
  }

  subscribe(listener: TrustListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
