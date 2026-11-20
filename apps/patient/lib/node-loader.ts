// Loads a trial node's public criteria: agent-manifest.json, criteria/index.json and each
// study's criteria file. Everything a node returns is untrusted: sizes are capped, shapes and
// the criteria schema are checked, and the node must publish exactly the directory's network.
// Requests carry no credentials, no referrer and no patient data (they are plain GETs).
// Call only after the visitor consented to this origin.
import type { CriteriaDocument } from "@chartstays/criteria-schema";
import type { DirectoryEntry } from "./directory.ts";
import { FIELD_LIMITS, type AgentFirewall } from "./firewall.ts";
import type { TrustLog } from "./trust-log.ts";

export const LIMITS = {
  manifestBytes: 64 * 1024,
  indexBytes: 256 * 1024,
  criteriaBytes: 256 * 1024,
  maxStudies: 50,
  timeoutMs: 10_000,
} as const;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface LoaderDeps {
  fetch: typeof fetch;
  validate: (doc: unknown) => ValidationResult;
  log?: TrustLog;
  /** Scans each request before it leaves and inspects what the node returns. */
  firewall?: AgentFirewall;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LoadedStudy {
  nct_id: string;
  title: string;
  status: string;
  /** Built from nct_id, never taken from the node. */
  ctgovUrl: string;
  criteria: CriteriaDocument;
}

export interface LoadedNode {
  entry: DirectoryEntry;
  studies: LoadedStudy[];
  rejected: { nct_id: string | null; reason: string }[];
}

export type NodeLoadErrorCode = "too_large" | "blocked" | "quarantined";

export class NodeLoadError extends Error {
  readonly code: NodeLoadErrorCode | undefined;
  constructor(message: string, code?: NodeLoadErrorCode) {
    super(message);
    this.name = "NodeLoadError";
    this.code = code;
  }
}

function quarantineError(firewall: AgentFirewall, origin: string): NodeLoadError {
  return new NodeLoadError(`Quarantined by the Agent Firewall for this session (${firewall.quarantineReason(origin) ?? "unsafe content"}). Its studies are not used.`, "quarantined");
}

const NCT_RE = /^NCT\d{8}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new NodeLoadError(`response is larger than ${maxBytes} bytes`, "too_large");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new NodeLoadError(`response is larger than ${maxBytes} bytes`, "too_large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

async function fetchJson(url: URL, maxBytes: number, origin: string, deps: LoaderDeps): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, deps.timeoutMs ?? LIMITS.timeoutMs);
  const path = url.pathname;
  let phiFields = 0;
  if (deps.firewall !== undefined && url.origin === origin) {
    // Nothing is sent (or logged as a contact) when the firewall refuses the request.
    const out = await deps.firewall.checkOutbound(origin, "request_url", url.href, "GET");
    const [first] = out.findings;
    if (first !== undefined) {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", abort);
      throw first.rule === "fw.quarantined" ? quarantineError(deps.firewall, origin) : new NodeLoadError(`${path} blocked by the Agent Firewall (${first.rule}): ${first.reason}`, "blocked");
    }
    phiFields = out.scan?.spans.length ?? 0;
  }
  try {
    if (url.origin !== origin) throw new NodeLoadError(`${url.href} is not on ${origin}`);
    const response = await deps.fetch(url.href, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "cors",
      signal: controller.signal,
    });
    if (response.redirected || response.type === "opaqueredirect") {
      deps.firewall?.inspectResponse(origin, path, { tooLarge: false, redirected: true });
      throw new NodeLoadError(`${path} redirected`, "blocked");
    }
    if (!response.ok) throw new NodeLoadError(`${path} returned HTTP ${response.status}`);
    let text: string;
    try {
      text = await readCapped(response, maxBytes);
    } catch (error) {
      if (error instanceof NodeLoadError && error.code === "too_large") deps.firewall?.inspectResponse(origin, path, { tooLarge: true, redirected: false });
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new NodeLoadError(`${path} is not valid JSON`);
    }
    const query = url.search.length > 1 ? url.search : "";
    deps.log?.record({
      type: "contact",
      origin,
      path,
      status: "ok",
      bytes: new TextEncoder().encode(text).byteLength,
      phiFields,
      ...(query !== "" ? { query: deps.firewall !== undefined ? await deps.firewall.redactForLog(query) : "[not shown]", queryLength: query.length } : {}),
    });
    return value;
  } catch (error) {
    const message = controller.signal.aborted
      ? `${path} timed out or was cancelled`
      : error instanceof NodeLoadError
        ? error.message
        : `${path} could not be fetched (${error instanceof Error ? error.message : String(error)})`;
    deps.log?.record({ type: "contact", origin, path, status: "error", detail: message });
    throw error instanceof NodeLoadError ? error : new NodeLoadError(message);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  }
}

export async function loadNodeData(entry: DirectoryEntry, deps: LoaderDeps): Promise<LoadedNode> {
  const origin = entry.origin;
  const root = new URL(`${origin}/`);

  const firewall = deps.firewall;
  // Returns what the firewall let through (unexpected fields dropped, flagged text neutralized);
  // the raw document is never used after this.
  const inspect = (file: "agent-manifest.json" | "criteria/index.json" | "criteria", value: unknown): unknown => {
    if (firewall === undefined) return value;
    const inspected = firewall.inspectJson(origin, file, value);
    if (inspected.quarantined) throw quarantineError(firewall, origin);
    return inspected.value;
  };
  if (firewall?.isQuarantined(origin)) throw quarantineError(firewall, origin);

  const manifest = inspect("agent-manifest.json", await fetchJson(new URL("agent-manifest.json", root), LIMITS.manifestBytes, origin, deps));
  if (!isRecord(manifest) || !Array.isArray(manifest["networks"])) throw new NodeLoadError("agent-manifest.json has no networks list");
  const names = (manifest["networks"] as unknown[]).map((n) => (isRecord(n) ? n["name"] : undefined));
  if (!names.includes(entry.network)) throw new NodeLoadError(`agent-manifest.json does not publish the network "${entry.network}" (exact name required)`);

  const index = inspect("criteria/index.json", await fetchJson(new URL("criteria/index.json", root), LIMITS.indexBytes, origin, deps));
  if (!isRecord(index) || !isRecord(index["node"]) || !Array.isArray(index["studies"])) throw new NodeLoadError("criteria/index.json has an unexpected shape");
  if (index["node"]["network"] !== entry.network) throw new NodeLoadError(`criteria/index.json names network "${String(index["node"]["network"])}", expected "${entry.network}"`);

  const studies: LoadedStudy[] = [];
  const rejected: LoadedNode["rejected"] = [];
  const listed = index["studies"] as unknown[];
  if (listed.length > LIMITS.maxStudies) rejected.push({ nct_id: null, reason: `only the first ${LIMITS.maxStudies} of ${listed.length} studies were read` });
  const seen = new Set<string>();
  for (const study of listed.slice(0, LIMITS.maxStudies)) {
    const nct = isRecord(study) && typeof study["nct_id"] === "string" ? study["nct_id"] : null;
    try {
      if (!isRecord(study) || nct === null || !NCT_RE.test(nct)) throw new NodeLoadError("study entry has no valid nct_id");
      if (seen.has(nct)) throw new NodeLoadError("duplicate study entry");
      seen.add(nct);
      if (typeof study["criteria"] !== "string") throw new NodeLoadError("study entry has no criteria path");
      const url = new URL(study["criteria"], root);
      if (url.origin !== origin) throw new NodeLoadError("criteria path points at another origin");
      const raw = await fetchJson(url, LIMITS.criteriaBytes, origin, deps);
      const result = deps.validate(raw);
      if (!result.valid) throw new NodeLoadError(`criteria failed the schema: ${result.errors.slice(0, 3).join("; ")}`);
      // The firewall's copy (every text field inspected, flagged ones neutralized), checked again.
      const doc = inspect("criteria", raw);
      const again = deps.validate(doc);
      if (!again.valid) throw new NodeLoadError(`criteria failed the schema after the Agent Firewall: ${again.errors.slice(0, 3).join("; ")}`);
      const criteria = doc as CriteriaDocument;
      if (criteria.nct_id !== nct) throw new NodeLoadError(`criteria file is for ${criteria.nct_id}`);
      const title = clip(criteria.title, FIELD_LIMITS.title);
      studies.push({
        nct_id: nct,
        title: title || nct,
        status: clip(study["status"], 40),
        ctgovUrl: `https://clinicaltrials.gov/study/${nct}`,
        criteria,
      });
    } catch (error) {
      if (deps.signal?.aborted || (error instanceof NodeLoadError && error.code === "quarantined")) throw error;
      rejected.push({ nct_id: nct !== null && NCT_RE.test(nct) ? nct : null, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { entry, studies, rejected };
}
