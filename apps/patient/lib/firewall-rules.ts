// Agent Firewall rules: one declarative table, applied by lib/firewall.ts to everything that
// goes to or comes from a trial node. Each rule names the subject it inspects, what it does
// on a hit (block, neutralize or quarantine the node) and a pure check, so every rule can be
// unit tested on its own. Rules never touch verdicts: those come only from the matcher.
//
//   outbound  request URLs and texts the app or its agents send to a node
//   inbound   what a node returns: manifest, criteria index, criteria files, response facts
import { CTGOV_ORIGINS } from "./link-guard.ts";
import { hasNonAscii, scanForms } from "./normalize.ts";
import { scanText, type ProfileTerms } from "./phi-scan.ts";

export type Direction = "inbound" | "outbound";
/** block: refuse this request or document. neutralize: drop or clip the content and go on. quarantine: stop using the node for this session. */
export type RuleAction = "block" | "neutralize" | "quarantine";

/** Longest question an agent may send to a node's assistant; the consent dialog shows all of it. */
export const MAX_REQUEST_TEXT = 140;
/** Most questions the agents may send to one node's assistant in a page session. */
export const MAX_QUESTIONS_PER_NODE = 5;
/** Longest run of characters without a space in a question (longer ones can hide encoded data). */
export const MAX_TOKEN = 40;
/** Limits on a node document's shape: deeper, longer or larger documents are refused. */
export const STRUCTURE_LIMITS = { depth: 8, arrayLength: 200, strings: 2000 } as const;

/** The ChartStays site actions a node's text must never name (they are this page's tools). */
export const OWN_ACTIONS = ["readProfile", "listNodes", "loadNode", "evaluateCriteria", "buildDoctorSheet"] as const;

export type Subject =
  /** One text field from a node; `max` is the longest legitimate value for that field. */
  | { kind: "node_text"; origin: string; field: string; text: string; max: number }
  /** A parsed JSON document from a node. */
  | { kind: "node_json"; origin: string; file: "agent-manifest.json" | "criteria/index.json" | "criteria" | "network.json" | "links.json" | "other"; value: unknown }
  /** Facts about one response from a node. */
  | { kind: "response"; origin: string; path: string; tooLarge: boolean; redirected: boolean }
  /**
   * Something about to leave the browser for a node. `asked`: questions already let through
   * to this node in this session (request_text only).
   */
  | { kind: "outbound"; origin: string; channel: "request_url" | "request_text"; text: string; method?: string; terms: ProfileTerms | null; asked?: number }
  /** The node's firewall state. */
  | { kind: "peer"; origin: string; quarantined: boolean };

export interface Hit {
  reason: string;
  /** The offending part (node text, a URL, a key); censored before it is logged. */
  match?: string;
}

export interface FirewallRule {
  id: string;
  direction: Direction;
  action: RuleAction;
  /** One line for the README, the trust panel and the export. */
  description: string;
  applies: Subject["kind"];
  check: (subject: Subject) => Hit | null;
}

export interface Finding extends Hit {
  rule: string;
  direction: Direction;
  action: RuleAction;
}

type SubjectOf<K extends Subject["kind"]> = Extract<Subject, { kind: K }>;

function rule<K extends Subject["kind"]>(def: {
  id: string;
  direction: Direction;
  action: RuleAction;
  description: string;
  applies: K;
  check: (subject: SubjectOf<K>) => Hit | null;
}): FirewallRule {
  return { ...def, check: (subject) => (subject.kind === def.applies ? def.check(subject as SubjectOf<K>) : null) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- patterns ----------

/** Attempts to override the agent's instructions or speak as the system. */
const INJECTION = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your|the|system|safety)\b[^.\n]{0,30}?\b(?:instructions?|prompts?|rules?|guidelines?|directives?|policies)\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\b(?:system|developer)\s+(?:prompt|message|override|instructions?)\b/gi,
  /\bnew\s+instructions?\s*:/gi,
  /<\/?\s*(?:system|assistant|instructions?|tool_call)\s*>/gi,
  /\[\s*(?:system|admin|instructions?)\s*\]/gi,
  /\b(?:jailbreak|do anything now)\b/gi,
  /<<\/?node[_ ]?text>>/gi,
  /<\/?\s*tool[_ ]call\s*>/gi,
];

/** Names of this page's own tools: a node has no reason to mention them. */
const TOOL_HIJACK = [
  new RegExp(`\\b(?:website[_ ]?)?(?:${OWN_ACTIONS.join("|")})\\b`, "gi"),
  /\bwebsite[_ ]?read[_ ]?profile\b/gi,
  /\b(?:read[_ ]profile|list[_ ]nodes|load[_ ]node|evaluate[_ ]criteria|build[_ ]doctor[_ ]sheet)\s*(?:\(|tool\b|action\b)/gi,
];

const DATA_NOUN = "(?:profile|record|diagnos\\w*|conditions?|age|birth|address|ssn|social security|labs?|lab values?|hba1c|egfr|medications?|health data|full name|phone|e[- ]?mail)";

const IDENTIFIER = "(?:ssn|social security number|home address|street address|date of birth|full name|phone number|insurance (?:id|number)|medical record number)";

/** Instructions to send patient data somewhere, or requests for identifiers (with a verb that asks for them). */
const DATA_REQUEST = [
  new RegExp(
    `\\b(?:send|post|forward|upload|transmit|share|include|append|attach|put|add|pass|provide|submit|report|leak)\\b[^.\\n]{0,80}?\\b${DATA_NOUN}\\b[^.\\n]{0,60}?\\b(?:to|in|into|with|via|as)\\s+(?:the\\s+|this\\s+|your\\s+|our\\s+|a\\s+|each\\s+)?(?:url|link|endpoint|query|request|question|message|https?:\\/\\/|us|server|webhook|form|parameter)`,
    "gi",
  ),
  new RegExp(
    `\\b(?:send|share|include|append|attach|submit|enter|type|post|forward|upload|transmit|put|add|leak|reply with|respond with|give (?:us|me)|tell (?:us|me)|provide (?:us |me )?(?:with )?(?:your|the patient's|their))\\b[^.\\n]{0,40}?\\b${IDENTIFIER}\\b`,
    "gi",
  ),
];

/** A negation directly before the request verb ("do not send ..."); only then is a data request harmless. */
const NEGATION = /\b(?:not|never|don't|do not|cannot|can't|must not|should not|nor)\s+(?:\w+\s+)?$/i;

const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;

/** Keys that ask for patient data in a node's documents. */
const FIELD_REQUEST_KEY = /(?:^|_)(?:requested|required|request|collect|patient|user|visitor)_?(?:fields?|data|attributes|profile|info)$|ssn|social_security|date_of_birth|home_address/i;

function matchesIn(patterns: readonly RegExp[], text: string, negatable: boolean): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      if (negatable && NEGATION.test(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0))) continue;
      out.push(m[0]);
    }
  }
  return out;
}

/** Matches in the original text and in its normalized forms (look-alikes, encodings, spelled-out words). */
function allMatches(patterns: readonly RegExp[], text: string, negatable = false): string[] {
  const out = matchesIn(patterns, text, negatable);
  if (out.length > 0) return out;
  for (const form of scanForms(text)) {
    out.push(...matchesIn(patterns, form.text, negatable));
    if (out.length > 0) break;
  }
  return out;
}

export type UrlKind = "allowed" | "foreign" | "exfil";

/** allowed: ClinicalTrials.gov or the node itself. exfil: elsewhere with data in its query, fragment or a {placeholder}. foreign: elsewhere. */
export function classifyUrl(href: string, allowedOrigins: ReadonlySet<string>): UrlKind {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "foreign";
  }
  if (allowedOrigins.has(url.origin) && url.username === "" && url.password === "") return "allowed";
  return url.search.length > 1 || url.hash.length > 1 || /\{|%7b/i.test(href) ? "exfil" : "foreign";
}

function inboundAllowed(origin: string): Set<string> {
  return new Set([origin, ...CTGOV_ORIGINS]);
}

function urlsOf(text: string, origin: string, kind: UrlKind): string[] {
  const allowed = inboundAllowed(origin);
  return [...text.matchAll(URL_RE)].map((m) => m[0]).filter((u) => classifyUrl(u, allowed) === kind);
}

/** Every key in a JSON value, with its path, at most `depth` levels deep. */
function keyPaths(value: unknown, depth = 5, prefix = ""): string[] {
  if (depth === 0) return [];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap((v, i) => keyPaths(v, depth - 1, `${prefix}[${i}]`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [`${prefix}${prefix ? "." : ""}${k}`, ...keyPaths(v, depth - 1, `${prefix}${prefix ? "." : ""}${k}`)]);
}

const MANIFEST_KEYS = new Set(["brand", "networks", "llm_router", "allowed_peers", "peer_policy", "agent_mcp", "theme", "linking", "deployment", "actions"]);
const NETWORK_KEYS = new Set(["name", "front_man", "hocon", "description", "tags", "sample_queries"]);
const INDEX_KEYS = new Set(["node", "disclaimer", "source", "studies"]);
const INDEX_NODE_KEYS = new Set(["slug", "network", "title", "description"]);
const STUDY_KEYS = new Set([
  "nct_id", "title", "status", "conditions", "phases", "sponsor", "summary", "url", "last_update_posted", "criteria", "logistics", "structured_criteria", "free_text_criteria",
]);

function unexpectedKeys(file: SubjectOf<"node_json">["file"], value: unknown): string[] {
  if (!isRecord(value)) return [];
  const extra = (obj: unknown, allowed: ReadonlySet<string>, at: string): string[] =>
    isRecord(obj) ? Object.keys(obj).filter((k) => !allowed.has(k)).map((k) => `${at}${k}`) : [];
  if (file === "agent-manifest.json") {
    const networks = Array.isArray(value["networks"]) ? value["networks"] : [];
    return [...extra(value, MANIFEST_KEYS, ""), ...networks.flatMap((n, i) => extra(n, NETWORK_KEYS, `networks[${i}].`))];
  }
  if (file === "criteria/index.json") {
    const studies = Array.isArray(value["studies"]) ? value["studies"] : [];
    return [...extra(value, INDEX_KEYS, ""), ...extra(value["node"], INDEX_NODE_KEYS, "node."), ...studies.flatMap((s, i) => extra(s, STUDY_KEYS, `studies[${i}].`))];
  }
  if (file === "links.json") return extra(value, LINKS_KEYS, "");
  // Criteria files are checked against the schema (no extra properties) before this.
  return [];
}

/** The profile fields a criteria document's structured criteria need. */
export function neededFields(doc: Record<string, unknown>): Set<string> {
  const needed = new Set<string>();
  for (const c of Array.isArray(doc["structured"]) ? doc["structured"] : []) {
    if (!isRecord(c)) continue;
    if (c["kind"] === "age") needed.add("age");
    else if (c["kind"] === "sex") needed.add("sex");
    else if (c["kind"] === "condition") needed.add("conditions");
    else if (c["kind"] === "medication") needed.add("medications");
    else if (c["kind"] === "lab" && typeof c["loinc"] === "string") needed.add(`labs:${c["loinc"]}`);
  }
  return needed;
}

function sameOriginPath(value: unknown, origin: string): boolean {
  if (typeof value !== "string") return true;
  try {
    return new URL(value, `${origin}/`).origin === origin;
  } catch {
    return false;
  }
}

/** Paths of the files a node publishes; their names carry no patient data. */
const ARTIFACT_PATH = /^\/(?:agent-manifest\.json|links\.json|criteria\/index\.json|criteria\/NCT\d{8}\.json|[A-Za-z0-9_-]+\.network\.json)$/;

/**
 * The parts of a request URL that could carry patient data: the query and fragment (with "+"
 * as a space), and the path unless it is one of the files a node publishes. The host is left
 * out: a node may be called "diabetes-trials.example".
 */
export function urlScanText(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const parts = [ARTIFACT_PATH.test(url.pathname) ? "" : url.pathname, url.search.replace(/\+/g, " "), url.hash.replace(/\+/g, " ")];
  return parts.filter((p) => p.length > 1).join(" ");
}

/** How a JSON value breaks STRUCTURE_LIMITS, or null when it does not. */
export function structureOverflow(value: unknown): string | null {
  let strings = 0;
  const walk = (v: unknown, depth: number): string | null => {
    if (typeof v === "string") {
      strings += 1;
      return strings > STRUCTURE_LIMITS.strings ? `more than ${STRUCTURE_LIMITS.strings} text fields` : null;
    }
    if (typeof v !== "object" || v === null) return null;
    if (depth >= STRUCTURE_LIMITS.depth) return `nested ${STRUCTURE_LIMITS.depth} or more levels deep`;
    const items = Array.isArray(v) ? v : Object.values(v);
    if (Array.isArray(v) && v.length > STRUCTURE_LIMITS.arrayLength) return `a list of ${v.length} items (limit ${STRUCTURE_LIMITS.arrayLength})`;
    for (const item of items) {
      const hit = walk(item, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(value, 0);
}

const LINKS_KEYS = new Set(["version", "networks"]);

function pick(obj: unknown, allowed: ReadonlySet<string>): unknown {
  return isRecord(obj) ? Object.fromEntries(Object.entries(obj).filter(([k]) => allowed.has(k))) : obj;
}

/** `value` with only the keys the file normally has (the ones in.unexpected-field reports are dropped). */
export function projectAllowed(file: SubjectOf<"node_json">["file"], value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (file === "agent-manifest.json") {
    const out = pick(value, MANIFEST_KEYS) as Record<string, unknown>;
    if (Array.isArray(out["networks"])) out["networks"] = out["networks"].map((n) => pick(n, NETWORK_KEYS));
    return out;
  }
  if (file === "criteria/index.json") {
    const out = pick(value, INDEX_KEYS) as Record<string, unknown>;
    if ("node" in out) out["node"] = pick(out["node"], INDEX_NODE_KEYS);
    if (Array.isArray(out["studies"])) out["studies"] = out["studies"].map((s) => pick(s, STUDY_KEYS));
    return out;
  }
  if (file === "links.json") return pick(value, LINKS_KEYS);
  return value;
}

// ---------- the table ----------

export const RULES: readonly FirewallRule[] = [
  rule({
    id: "out.phi",
    direction: "outbound",
    action: "block",
    description:
      "A request or question that contains health data from the imported record is blocked before it leaves the browser (also when disguised: look-alike letters, encoding, spelled out). For URLs, the query, fragment and any path other than a node's published files are checked.",
    applies: "outbound",
    check: (s) => {
      if (s.terms === null) return null;
      const text = s.channel === "request_url" ? urlScanText(s.text) : s.text;
      const scan = scanText(text, s.terms);
      if (scan.status === "clean") return null;
      const kinds = [...new Set(scan.spans.map((sp) => sp.kind))].join(", ");
      return { reason: `contains health data from your record (${kinds})`, match: text };
    },
  }),
  rule({
    id: "out.length",
    direction: "outbound",
    action: "block",
    description: "A question to a node's assistant longer than 140 characters is blocked, so the dialog can show all of it.",
    applies: "outbound",
    check: (s) =>
      s.channel === "request_text" && s.text.length > MAX_REQUEST_TEXT ? { reason: `the question is longer than ${MAX_REQUEST_TEXT} characters (${s.text.length})` } : null,
  }),
  rule({
    id: "out.charset",
    direction: "outbound",
    action: "block",
    description: "A question with characters other than plain printable ASCII (invisible, look-alike or control characters) is blocked.",
    applies: "outbound",
    check: (s) => (s.channel === "request_text" && hasNonAscii(s.text) ? { reason: "the question has characters other than plain printable ASCII" } : null),
  }),
  rule({
    id: "out.long-token",
    direction: "outbound",
    action: "block",
    description: `A question with a run of more than ${MAX_TOKEN} characters without a space (a way to hide encoded data) is blocked.`,
    applies: "outbound",
    check: (s) => {
      if (s.channel !== "request_text") return null;
      const long = s.text.split(/\s+/).find((t) => t.length > MAX_TOKEN);
      return long === undefined ? null : { reason: `the question has a ${long.length}-character word (limit ${MAX_TOKEN})` };
    },
  }),
  rule({
    id: "out.quota",
    direction: "outbound",
    action: "block",
    description: `At most ${MAX_QUESTIONS_PER_NODE} questions go to one node's assistant per page session, even when the patient allowed the node for the session.`,
    applies: "outbound",
    check: (s) =>
      s.channel === "request_text" && (s.asked ?? 0) >= MAX_QUESTIONS_PER_NODE
        ? { reason: `${MAX_QUESTIONS_PER_NODE} questions were already sent to this node in this session` }
        : null,
  }),
  rule({
    id: "out.method",
    direction: "outbound",
    action: "block",
    description: "Only plain GET requests reach a node: no bodies, uploads or form posts.",
    applies: "outbound",
    check: (s) => (s.channel === "request_url" && s.method !== undefined && s.method.toUpperCase() !== "GET" ? { reason: `only GET is allowed to a trial node (got ${s.method.toUpperCase()})` } : null),
  }),
  rule({
    id: "fw.quarantined",
    direction: "outbound",
    action: "block",
    description: "A quarantined node is not contacted again in this session.",
    applies: "peer",
    check: (s) => (s.quarantined ? { reason: "the node is quarantined for this session" } : null),
  }),
  rule({
    id: "in.injection",
    direction: "inbound",
    action: "quarantine",
    description: "Node text that tries to override the agent's instructions (\"ignore previous instructions\", fake system tags) quarantines the node.",
    applies: "node_text",
    check: (s) => {
      const [first] = allMatches(INJECTION, s.text);
      return first === undefined ? null : { reason: `prompt injection in ${s.field}`, match: first };
    },
  }),
  rule({
    id: "in.tool-hijack",
    direction: "inbound",
    action: "quarantine",
    description: "Node text that names this page's own tools (readProfile and the other site actions) quarantines the node.",
    applies: "node_text",
    check: (s) => {
      const [first] = allMatches(TOOL_HIJACK, s.text);
      return first === undefined ? null : { reason: `tries to steer the agent to this page's tool ${first} in ${s.field}`, match: first };
    },
  }),
  rule({
    id: "in.data-request",
    direction: "inbound",
    action: "quarantine",
    description: "Node text that asks for patient data or identifiers (send the diagnosis in your request, SSN, address) quarantines the node.",
    applies: "node_text",
    check: (s) => {
      const [first] = allMatches(DATA_REQUEST, s.text, true);
      return first === undefined ? null : { reason: `asks for patient data in ${s.field}`, match: first };
    },
  }),
  rule({
    id: "in.exfil-url",
    direction: "inbound",
    action: "quarantine",
    description: "A link in node text to another site that carries a query, fragment or {placeholder} (a way to smuggle data out) quarantines the node.",
    applies: "node_text",
    check: (s) => {
      const [first] = urlsOf(s.text, s.origin, "exfil");
      return first === undefined ? null : { reason: `exfiltration link in ${s.field}`, match: first };
    },
  }),
  rule({
    id: "in.foreign-url",
    direction: "inbound",
    action: "neutralize",
    description: "A plain link in node text to a site other than ClinicalTrials.gov or the node is removed before any agent sees it.",
    applies: "node_text",
    check: (s) => {
      const [first] = urlsOf(s.text, s.origin, "foreign");
      return first === undefined ? null : { reason: `link to another site removed from ${s.field}`, match: first };
    },
  }),
  rule({
    id: "in.oversize-field",
    direction: "inbound",
    action: "neutralize",
    description: "A node text field longer than any legitimate value is clipped.",
    applies: "node_text",
    check: (s) => (s.text.length > s.max ? { reason: `${s.field} is ${s.text.length} characters (limit ${s.max}); clipped` } : null),
  }),
  rule({
    id: "in.structure",
    direction: "inbound",
    action: "quarantine",
    description: `A node document nested ${STRUCTURE_LIMITS.depth} or more levels deep, with a list of more than ${STRUCTURE_LIMITS.arrayLength} items or more than ${STRUCTURE_LIMITS.strings} text fields (too big to inspect fully) quarantines the node.`,
    applies: "node_json",
    check: (s) => {
      const overflow = structureOverflow(s.value);
      return overflow === null ? null : { reason: `${s.file} is ${overflow}, too large to inspect` };
    },
  }),
  rule({
    id: "in.unexpected-field",
    direction: "inbound",
    action: "neutralize",
    description: "Fields a node document does not normally have are dropped.",
    applies: "node_json",
    check: (s) => {
      const extra = unexpectedKeys(s.file, s.value);
      return extra.length === 0 ? null : { reason: `unexpected fields in ${s.file} dropped: ${extra.slice(0, 5).join(", ")}`, match: extra.join(", ") };
    },
  }),
  rule({
    id: "in.excess-fields",
    direction: "inbound",
    action: "quarantine",
    description: "A node that asks for more patient fields than its criteria need (or for identifiers) is quarantined.",
    applies: "node_json",
    check: (s) => {
      if (s.file === "criteria" && isRecord(s.value)) {
        const requested = Array.isArray(s.value["requested_fields_for_inquiry"]) ? s.value["requested_fields_for_inquiry"] : [];
        const needed = neededFields(s.value);
        const extra = requested.filter((f): f is string => typeof f === "string" && !needed.has(f));
        if (extra.length > 0) return { reason: `requests fields its criteria do not need: ${extra.join(", ")}`, match: extra.join(", ") };
        return null;
      }
      const keys = keyPaths(s.value).filter((k) => FIELD_REQUEST_KEY.test(k.split(".").at(-1)!.replace(/\[\d+\]$/, "")));
      return keys.length === 0 ? null : { reason: `asks for patient fields in ${s.file}: ${keys.slice(0, 3).join(", ")}`, match: keys.join(", ") };
    },
  }),
  rule({
    id: "in.bridge",
    direction: "inbound",
    action: "quarantine",
    description: "A manifest whose action bridge or module points off the node, that shadows this page's tools, or that offers an MCP endpoint is quarantined (the app never opens bridges or MCP).",
    applies: "node_json",
    check: (s) => {
      if (s.file !== "agent-manifest.json" || !isRecord(s.value)) return null;
      const actions = s.value["actions"];
      if (isRecord(actions)) {
        for (const key of ["bridge", "module"] as const) {
          if (!sameOriginPath(actions[key], s.origin)) return { reason: `actions.${key} points to another site`, match: String(actions[key]) };
        }
        const tools = Array.isArray(actions["agentTools"]) ? actions["agentTools"].map(String) : [];
        const own = new Set(OWN_ACTIONS.map((a) => a.toLowerCase()));
        const shadow = tools.find((t) => own.has(t.toLowerCase().replace(/^website_/, "").replace(/_/g, "")));
        if (shadow !== undefined) return { reason: `actions.agentTools shadows this page's tool ${shadow}`, match: shadow };
      }
      const mcp = s.value["agent_mcp"];
      if (isRecord(mcp)) {
        const endpoint = Object.values(mcp).find((v) => typeof v === "string" && /^https?:\/\//i.test(v));
        if (mcp["available"] === true || endpoint !== undefined) return { reason: "offers an MCP endpoint the app does not use", match: typeof endpoint === "string" ? endpoint : "agent_mcp.available" };
      }
      return null;
    },
  }),
  rule({
    id: "in.oversize-response",
    direction: "inbound",
    action: "block",
    description: "A response larger than its size cap is discarded.",
    applies: "response",
    check: (s) => (s.tooLarge ? { reason: `${s.path} is larger than its size cap` } : null),
  }),
  rule({
    id: "in.redirect",
    direction: "inbound",
    action: "block",
    description: "A redirect from a node is refused; requests never follow it.",
    applies: "response",
    check: (s) => (s.redirected ? { reason: `${s.path} redirected` } : null),
  }),
];

/** Every rule's hit for `subject`, in table order. */
export function runRules(subject: Subject, rules: readonly FirewallRule[] = RULES): Finding[] {
  const out: Finding[] = [];
  for (const r of rules) {
    if (r.applies !== subject.kind) continue;
    const hit = r.check(subject);
    if (hit !== null) out.push({ ...hit, rule: r.id, direction: r.direction, action: r.action });
  }
  return out;
}

export const NEUTRALIZED = "[removed by firewall]";
export const LINK_REMOVED = "[link removed]";

/**
 * Node text with injection attempts, tool names, data requests and links off
 * ClinicalTrials.gov (and `origin`, when given) replaced, then clipped to `max`.
 */
export function neutralizeText(text: string, max: number, origin?: string): string {
  const allowed = origin === undefined ? new Set<string>(CTGOV_ORIGINS) : inboundAllowed(origin);
  // Control and invisible characters (zero-width, bidi controls) go first.
  let out = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\p{Cf}]/gu, "");
  for (const pattern of [...INJECTION, ...TOOL_HIJACK]) out = out.replace(pattern, NEUTRALIZED);
  for (const pattern of DATA_REQUEST) {
    out = out.replace(pattern, (m: string, ...rest: unknown[]) => {
      const at = rest.find((r): r is number => typeof r === "number") ?? 0;
      return NEGATION.test(out.slice(Math.max(0, at - 40), at)) ? m : NEUTRALIZED;
    });
  }
  // A disguised attempt (look-alike letters, encoding, spelled out) cannot be cut out of the
  // original reliably, so the whole text is dropped.
  if (allMatches(INJECTION, out).length > 0 || allMatches(TOOL_HIJACK, out).length > 0 || allMatches(DATA_REQUEST, out, true).length > 0) out = NEUTRALIZED;
  out = out.replace(URL_RE, (u) => (classifyUrl(u, allowed) === "allowed" ? u : LINK_REMOVED));
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Text safe to keep in the trust log: no control characters, no URL query or fragment, clipped. */
export function censor(text: string, max = 160): string {
  const clean = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(URL_RE, (u) => u.replace(/[?#].*$/, (q) => (q.length > 1 ? `${q[0]}…` : q)))
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
