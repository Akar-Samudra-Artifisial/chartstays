// Agent Firewall: applies the rule table (firewall-rules.ts) on the app's existing paths to the
// trial nodes (node-loader, peer-fetch, the runtime consent gate, site actions). Outbound text
// is scanned for health data from the record and blocked on a hit, failing closed when the
// scan cannot run. Inbound node content is inspected; light findings are neutralized, heavy
// ones quarantine the node for this page session. Every decision goes to the trust log with its
// rule id, the origin, the reason and a censored snippet (never health data: blocked outbound
// text is logged only with each detected value replaced by its kind).
// The firewall never changes a verdict: it can only keep a node's studies out of a run.
import { censor, neutralizeText, projectAllowed, RULES, runRules, urlScanText, type Finding, type FirewallRule, type RuleAction, type Subject } from "./firewall-rules.ts";
import { redactedSegments, scanText, type PhiScan, type PhiSegment, type ProfileTerms } from "./phi-scan.ts";
import type { FirewallAction, TrustLog } from "./trust-log.ts";

/** Longest legitimate value per node text field, from the published nodes (with headroom). */
export const FIELD_LIMITS = {
  title: 300,
  label: 600,
  /** free_text[].text */
  text: 2000,
  source_text: 1500,
  note: 1500,
  criteria_text: 8000,
  summary: 600,
  description: 600,
  name: 120,
  default: 600,
  network: 8000,
} as const;

export type NodeJsonFile = Extract<Subject, { kind: "node_json" }>["file"];

const ACTION_LOG: Record<RuleAction, FirewallAction> = { block: "blocked", neutralize: "neutralized", quarantine: "quarantined" };

export interface FirewallDeps {
  log: TrustLog;
  /** Terms from the current profile; null when no profile is imported. */
  terms?: () => Promise<ProfileTerms | null>;
  rules?: readonly FirewallRule[];
}

export interface OutboundCheck {
  allowed: boolean;
  findings: Finding[];
  /** The health-data scan of the text; null when no profile is imported. */
  scan: PhiScan | null;
  /** The text with every detected value replaced by its kind (safe to log and show). */
  redacted: PhiSegment[];
}

export interface InspectResult {
  findings: Finding[];
  quarantined: boolean;
}

export class FirewallBlockedError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.name = "FirewallBlockedError";
    this.rule = rule;
  }
}

export class AgentFirewall {
  #log: TrustLog;
  #terms: () => Promise<ProfileTerms | null>;
  #rules: readonly FirewallRule[];
  #quarantine = new Map<string, string>();
  /** Questions let through per origin (out.quota). */
  #asked = new Map<string, number>();
  #listeners = new Set<() => void>();

  constructor(deps: FirewallDeps) {
    this.#log = deps.log;
    this.#terms = deps.terms ?? (async () => null);
    this.#rules = deps.rules ?? RULES;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isQuarantined(origin: string): boolean {
    return this.#quarantine.has(origin);
  }

  /** Quarantined origins with the reason of the finding that quarantined each. */
  quarantined(): { origin: string; reason: string }[] {
    return [...this.#quarantine].map(([origin, reason]) => ({ origin, reason }));
  }

  quarantineReason(origin: string): string | undefined {
    return this.#quarantine.get(origin);
  }

  #run(subject: Subject): Finding[] {
    return runRules(subject, this.#rules);
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not stop the firewall.
      }
    }
  }

  #record(origin: string, finding: Finding, extra: { field?: string; snippet?: string; redacted?: PhiSegment[] }): void {
    this.#log.record({
      type: "firewall",
      origin,
      direction: finding.direction,
      rule: finding.rule,
      action: ACTION_LOG[finding.action],
      reason: finding.reason,
      ...extra,
    });
    if (finding.action === "quarantine" && !this.#quarantine.has(origin)) {
      this.#quarantine.set(origin, `${finding.rule}: ${finding.reason}`);
      this.#changed();
    }
  }

  /**
   * Check something about to leave the browser for `origin`. Blocked findings are logged;
   * the caller must not send when `allowed` is false. Fails closed when the scan throws.
   */
  async checkOutbound(origin: string, channel: "request_url" | "request_text", text: string, method?: string): Promise<OutboundCheck> {
    const peer = this.#run({ kind: "peer", origin, quarantined: this.isQuarantined(origin) });
    let terms: ProfileTerms | null;
    let failed = false;
    try {
      terms = await this.#terms();
    } catch {
      terms = null;
      failed = true;
    }
    // For a URL only the parts that could carry data are scanned (never the host).
    const scanned = channel === "request_url" ? urlScanText(text) : text;
    const scan = terms === null ? null : scanText(scanned, terms);
    const redacted = scan === null ? [{ text: scanned }] : redactedSegments(scanned, scan.spans);
    const asked = this.#asked.get(origin) ?? 0;
    const findings = [
      ...peer,
      ...this.#run({ kind: "outbound", origin, channel, text, terms, asked, ...(method !== undefined ? { method } : {}) }),
      ...(failed ? [{ rule: "out.phi", direction: "outbound" as const, action: "block" as const, reason: "the health-data check could not run, so nothing was sent" }] : []),
    ];
    if (channel === "request_text" && findings.length === 0) this.#asked.set(origin, asked + 1);
    const safe = redacted.map((s) => s.text).join("");
    for (const f of findings) {
      // Outbound text is logged only redacted: the scan replaced every detected value by its kind.
      this.#record(origin, f, {
        field: channel,
        ...(failed ? {} : { snippet: censor(safe) }),
        ...(scan !== null && scan.status === "blocked" ? { redacted } : {}),
      });
    }
    return { allowed: findings.length === 0, findings, scan, redacted };
  }

  /** Inspect one node text field; returns the neutralized text the app and agents may see. */
  inspectText(origin: string, field: string, text: string, max: number = FIELD_LIMITS.default): InspectResult & { text: string } {
    const findings = this.#run({ kind: "node_text", origin, field, text, max });
    for (const f of findings) this.#record(origin, f, { field, ...(f.match !== undefined ? { snippet: censor(f.match) } : {}) });
    return { text: findings.length === 0 ? text : neutralizeText(text, max, origin), findings, quarantined: this.isQuarantined(origin) };
  }

  /**
   * Inspect a parsed node document and every text field in it. `value` in the result is a copy
   * with each flagged text field neutralized (the input is not changed).
   */
  inspectJson(origin: string, file: NodeJsonFile, value: unknown): InspectResult & { value: unknown } {
    const findings = this.#run({ kind: "node_json", origin, file, value });
    for (const f of findings) this.#record(origin, f, { field: file, ...(f.match !== undefined ? { snippet: censor(f.match) } : {}) });
    // A document too large to inspect fully (in.structure) is refused, never passed on partly checked.
    if (findings.some((f) => f.rule === "in.structure")) return { findings, quarantined: true, value: null };
    const projected = projectAllowed(file, value);
    const replaced = new Map<string, string>();
    for (const [field, text] of textFields(projected)) {
      // The manifest's LLM router is never used: the app always runs its own (and peer-fetch drops it).
      if (file === "agent-manifest.json" && field.startsWith("llm_router")) continue;
      const result = this.inspectText(origin, `${file}:${field}`, text, limitFor(file, field));
      if (result.findings.length > 0) {
        findings.push(...result.findings);
        replaced.set(field, result.text);
      }
    }
    return { findings, quarantined: this.isQuarantined(origin), value: replaced.size === 0 ? projected : replaceStrings(projected, replaced) };
  }

  /**
   * A URL query (or fragment) or message safe to log: each detected health-data value replaced
   * by its kind, censored and clipped (`max`, default 120). `keep`: public identifiers (directory
   * origins, hosts, network names) left as they are, so "t2d_trials" never becomes "[condition]_trials".
   */
  async redactForLog(text: string, options: { keep?: readonly string[]; max?: number } = {}): Promise<string> {
    let terms: ProfileTerms | null = null;
    try {
      terms = await this.#terms();
    } catch {
      return "[not shown: the health-data check could not run]";
    }
    const scan = terms === null ? null : scanText(text, terms);
    const kept = keptRanges(text, options.keep ?? []);
    const spans = scan === null ? [] : scan.spans.filter((s) => !kept.some(([from, to]) => s.start >= from && s.end <= to));
    const safe = redactedSegments(text, spans).map((s) => s.text).join("");
    return censor(safe, options.max ?? 120);
  }

  /** Facts about a response (size cap hit, redirect). */
  inspectResponse(origin: string, path: string, facts: { tooLarge: boolean; redirected: boolean }): InspectResult {
    const findings = this.#run({ kind: "response", origin, path, ...facts });
    for (const f of findings) this.#record(origin, f, { field: path });
    return { findings, quarantined: this.isQuarantined(origin) };
  }
}

/** [start, end) of every case-insensitive occurrence of a non-empty `keep` string in `text`. */
function keptRanges(text: string, keep: readonly string[]): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const word of keep) {
    const needle = word.toLowerCase();
    if (needle === "") continue;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) ranges.push([at, at + needle.length]);
  }
  return ranges;
}

function limitFor(file: NodeJsonFile, field: string): number {
  // A network's instructions are the node assistant's prompt: long by design.
  if (file === "network.json") return FIELD_LIMITS.network;
  const last = field.split(".").at(-1)!.replace(/\[\d+\]$/, "");
  return last in FIELD_LIMITS ? FIELD_LIMITS[last as keyof typeof FIELD_LIMITS] : FIELD_LIMITS.default;
}

/**
 * Every string in a node document, with its path. Only call on a document within
 * STRUCTURE_LIMITS (inspectJson refuses the others first), so nothing is skipped.
 */
export function textFields(value: unknown, prefix = "", out: [string, string][] = []): [string, string][] {
  if (typeof value === "string") {
    out.push([prefix, value]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => textFields(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) textFields(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** A copy of `value` with the strings at the given paths (as textFields names them) replaced. */
function replaceStrings(value: unknown, replaced: ReadonlyMap<string, string>, prefix = ""): unknown {
  if (typeof value === "string") return replaced.get(prefix) ?? value;
  if (Array.isArray(value)) return value.map((v, i) => replaceStrings(v, replaced, `${prefix}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, replaced, prefix ? `${prefix}.${k}` : k)]));
  }
  return value;
}
