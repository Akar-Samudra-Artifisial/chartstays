// One page session of trial matching: which nodes were loaded (after consent), denied or
// failed, and the latest local match results. The "Find trials for me" button and the
// agent's site actions share it, so both paths load and match the same way.
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import type { PatientProfile } from "@chartstays/fhir-profile";
import { rankStudies, type StudyResult } from "@chartstays/matcher";
import { PURPOSE_LOAD, type ConsentManager } from "./consent.ts";
import type { DirectoryEntry } from "./directory.ts";
import type { AgentFirewall } from "./firewall.ts";
import { loadNodeData, NodeLoadError, type LoadedNode, type LoaderDeps } from "./node-loader.ts";
import type { TrustLog } from "./trust-log.ts";

export type NodeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; studies: number; rejected: LoadedNode["rejected"] }
  | { status: "denied"; message: string }
  | { status: "error"; message: string }
  /** The Agent Firewall stopped using this node for the session; none of its studies are matched. */
  | { status: "quarantined"; message: string };

export interface MatchRow extends StudyResult {
  node: { name: string; origin: string; area: string };
  ctgovUrl: string;
  recruitment: string;
  /** Date (YYYY-MM-DD) the ClinicalTrials.gov record was downloaded for the node's snapshot. */
  retrieved: string;
}

export interface MatchRun {
  asOf: string;
  rows: MatchRow[];
  /** Directory origins whose criteria were not part of this run, with the reason. */
  missing: { origin: string; name: string; status: NodeState["status"]; message: string }[];
  /** Studies a loaded node listed but the loader rejected, with the reason. */
  rejected: { origin: string; name: string; nct_id: string | null; reason: string }[];
}

export interface SessionDeps {
  directory: () => Promise<DirectoryEntry[]>;
  profile: () => Promise<PatientProfile | null>;
  consent: ConsentManager;
  loader: Omit<LoaderDeps, "signal" | "log" | "firewall">;
  log: TrustLog;
  firewall?: AgentFirewall;
}

export type LoadOutcome =
  | { origin: string; status: "loaded"; network: string; studies: number; rejected: number }
  | { origin: string; status: "denied"; message: string }
  | { origin: string; status: "error"; message: string }
  | { origin: string; status: "quarantined"; message: string };

function quarantinedMessage(reason: string | undefined): string {
  return `Quarantined by the Agent Firewall for this session${reason === undefined ? "" : ` (${reason})`}. Its studies are not used.`;
}

export function deniedMessage(origin: string): string {
  return `Access to ${origin} denied`;
}

export class TrialSession {
  #deps: SessionDeps;
  #loaded = new Map<string, LoadedNode>();
  #states = new Map<string, NodeState>();
  #inflight = new Map<string, Promise<LoadOutcome>>();
  #run: MatchRun | null = null;
  #revision = 0;
  #listeners = new Set<() => void>();

  constructor(deps: SessionDeps) {
    this.#deps = deps;
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
        // A broken listener must not stop matching.
      }
    }
  }

  #set(origin: string, state: NodeState): void {
    this.#states.set(origin, state);
    // Which criteria are loaded may have changed: views built from an earlier run are stale.
    this.#revision += 1;
    this.#changed();
  }

  /** Increases whenever a node's state changes (load, deny, error, quarantine). */
  revision(): number {
    return this.#revision;
  }

  /** The loaded criteria of one study, or null. */
  criteriaFor(nctId: string): CriteriaDocument | null {
    for (const [origin, node] of this.#loaded) {
      if (this.#deps.firewall?.isQuarantined(origin)) continue;
      const study = node.studies.find((s) => s.nct_id === nctId);
      if (study !== undefined) return study.criteria;
    }
    return null;
  }

  state(origin: string): NodeState {
    const firewall = this.#deps.firewall;
    if (firewall?.isQuarantined(origin)) return { status: "quarantined", message: quarantinedMessage(firewall.quarantineReason(origin)) };
    return this.#states.get(origin) ?? { status: "idle" };
  }

  #quarantine(origin: string): LoadOutcome {
    // The firewall may quarantine a node after it loaded (e.g. its assistant's files): drop its studies.
    this.#loaded.delete(origin);
    const message = quarantinedMessage(this.#deps.firewall?.quarantineReason(origin));
    this.#set(origin, { status: "quarantined", message });
    return { origin, status: "quarantined", message };
  }

  /** The latest run shown on the page; it may predate a later load (the doctor sheet re-evaluates). */
  lastRun(): MatchRun | null {
    return this.#run;
  }

  /** Criteria of every loaded node (for scoping what readProfile may show). */
  loadedCriteria(): CriteriaDocument[] {
    return [...this.#loaded.values()].filter((node) => !this.#deps.firewall?.isQuarantined(node.entry.origin)).flatMap((node) => node.studies.map((s) => s.criteria));
  }

  async entries(): Promise<DirectoryEntry[]> {
    return this.#deps.directory();
  }

  /** The directory entry for a URL or origin the caller passed, or undefined. */
  async resolve(input: string): Promise<DirectoryEntry | undefined> {
    let origin: string;
    try {
      origin = new URL(input.trim()).origin;
    } catch {
      return undefined;
    }
    return (await this.entries()).find((e) => e.origin === origin);
  }

  /**
   * Ask consent for one node, then load its public criteria. Nothing is fetched from the
   * node before an explicit allow. One node failing never affects another.
   */
  async loadNode(input: string, via: "find" | "agent", signal?: AbortSignal): Promise<LoadOutcome> {
    const entry = await this.resolve(input);
    if (entry === undefined) {
      return { origin: input.slice(0, 200), status: "error", message: "Not a trial node in the ChartStays directory; nothing was contacted." };
    }
    // A quarantined node is not asked about or contacted again.
    if (this.#deps.firewall?.isQuarantined(entry.origin)) return this.#quarantine(entry.origin);
    const cached = this.#loaded.get(entry.origin);
    if (cached !== undefined) {
      return { origin: entry.origin, status: "loaded", network: entry.network, studies: cached.studies.length, rejected: cached.rejected.length };
    }
    const pending = this.#inflight.get(entry.origin);
    if (pending !== undefined) return pending;
    const task = this.#load(entry, via, signal).finally(() => this.#inflight.delete(entry.origin));
    this.#inflight.set(entry.origin, task);
    return task;
  }

  async #load(entry: DirectoryEntry, via: "find" | "agent", signal?: AbortSignal): Promise<LoadOutcome> {
    const { origin } = entry;
    const allowed = await this.#deps.consent.request({ origin, network: entry.network, label: entry.name, purpose: PURPOSE_LOAD }, via);
    if (!allowed) {
      const message = deniedMessage(origin);
      this.#set(origin, { status: "denied", message });
      return { origin, status: "denied", message };
    }
    this.#set(origin, { status: "loading" });
    try {
      const firewall = this.#deps.firewall;
      const node = await loadNodeData(entry, { ...this.#deps.loader, log: this.#deps.log, signal, ...(firewall !== undefined ? { firewall } : {}) });
      if (firewall?.isQuarantined(origin)) return this.#quarantine(origin);
      this.#loaded.set(origin, node);
      this.#set(origin, { status: "loaded", studies: node.studies.length, rejected: node.rejected });
      return { origin, status: "loaded", network: entry.network, studies: node.studies.length, rejected: node.rejected.length };
    } catch (error) {
      if ((error instanceof NodeLoadError && error.code === "quarantined") || this.#deps.firewall?.isQuarantined(origin)) return this.#quarantine(origin);
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.log.record({ type: "error", origin, message });
      this.#set(origin, { status: "error", message });
      return { origin, status: "error", message };
    }
  }

  /** Load every directory node in turn (one consent dialog each), then match. */
  async findAll(signal?: AbortSignal): Promise<MatchRun> {
    for (const entry of await this.entries()) {
      if (signal?.aborted) break;
      await this.loadNode(entry.origin, "find", signal);
    }
    return this.evaluate();
  }

  /**
   * Match the profile against the criteria already loaded, in this browser. Never contacts
   * a node: it only reads what loadNode stored.
   */
  async evaluate(origins?: readonly string[]): Promise<MatchRun> {
    const profile = await this.#deps.profile();
    if (profile === null) throw new Error("No health record is imported yet. Import one on the home page first.");
    if (profile.deceased) throw new Error("The imported record marks the patient as deceased; trial matching does not apply.");
    const entries = await this.entries();
    const wanted = origins === undefined || origins.length === 0 ? null : new Set(origins.map((o) => o.trim()));

    const docs: CriteriaDocument[] = [];
    const meta = new Map<string, { node: LoadedNode; recruitment: string; ctgovUrl: string; retrieved: string }>();
    const missing: MatchRun["missing"] = [];
    const rejected: MatchRun["rejected"] = [];
    for (const entry of entries) {
      if (wanted !== null && !wanted.has(entry.origin)) continue;
      if (this.#deps.firewall?.isQuarantined(entry.origin)) this.#loaded.delete(entry.origin);
      const node = this.#loaded.get(entry.origin);
      if (node === undefined) {
        const state = this.state(entry.origin);
        const message = state.status === "denied" || state.status === "error" || state.status === "quarantined" ? state.message : "Not loaded yet.";
        missing.push({ origin: entry.origin, name: entry.name, status: state.status, message });
        continue;
      }
      for (const r of node.rejected) rejected.push({ origin: entry.origin, name: entry.name, nct_id: r.nct_id, reason: r.reason });
      for (const study of node.studies) {
        if (meta.has(study.nct_id)) continue;
        meta.set(study.nct_id, { node, recruitment: study.status, ctgovUrl: study.ctgovUrl, retrieved: study.criteria.source.retrieved });
        docs.push(study.criteria);
      }
    }
    const rows = rankStudies(profile, docs).map((result): MatchRow => {
      const m = meta.get(result.nct_id)!;
      return {
        ...result,
        node: { name: m.node.entry.name, origin: m.node.entry.origin, area: m.node.entry.area },
        ctgovUrl: m.ctgovUrl,
        recruitment: m.recruitment,
        retrieved: m.retrieved,
      };
    });
    this.#run = { asOf: profile.asOf, rows, missing, rejected };
    this.#changed();
    return this.#run;
  }
}
