// The trial node directory (public/directory.json, written at build time by
// scripts/configure-nodes.mjs from the node base URL config). Same-origin, public data.

export interface DirectoryEntry {
  name: string;
  /** Exact origin, e.g. https://t2d.example.pages.dev or http://localhost:4101. */
  origin: string;
  area: string;
  /** Network name the node must publish in its agent-manifest.json. */
  network: string;
  /** Set only for adversarial demo nodes (config/nodes.demo.json); never in the default build. */
  demo?: true;
}

export const MAX_NODES = 8;
export const DIRECTORY_URL = "/directory.json";

const NETWORK_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The origin when `value` is an exact http(s) origin (https unless loopback), else null. */
export function exactOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.origin;
  return null;
}

export function parseDirectory(value: unknown): DirectoryEntry[] {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["nodes"])) throw new Error("directory.json: expected {version: 1, nodes: [...]}");
  const nodes = value["nodes"] as unknown[];
  if (nodes.length > MAX_NODES) throw new Error(`directory.json: more than ${MAX_NODES} nodes`);
  const seen = new Set<string>();
  return nodes.map((node, i) => {
    if (!isRecord(node)) throw new Error(`directory.json: nodes[${i}] is not an object`);
    const origin = exactOrigin(node["origin"]);
    const { name, area, network } = node;
    if (origin === null) throw new Error(`directory.json: nodes[${i}].origin must be an exact https origin (http only on localhost)`);
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw new Error(`directory.json: nodes[${i}].name is invalid`);
    if (typeof area !== "string" || !/^[a-z0-9-]{1,64}$/.test(area)) throw new Error(`directory.json: nodes[${i}].area is invalid`);
    if (typeof network !== "string" || !NETWORK_RE.test(network)) throw new Error(`directory.json: nodes[${i}].network is invalid`);
    if (seen.has(origin)) throw new Error(`directory.json: duplicate origin ${origin}`);
    if (node["demo"] !== undefined && node["demo"] !== true) throw new Error(`directory.json: nodes[${i}].demo must be true when set`);
    seen.add(origin);
    return node["demo"] === true ? { name, origin, area, network, demo: true } : { name, origin, area, network };
  });
}

export async function fetchDirectory(fetchImpl: typeof fetch = fetch): Promise<DirectoryEntry[]> {
  const response = await fetchImpl(DIRECTORY_URL, { credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error(`directory.json returned HTTP ${response.status}`);
  return parseDirectory(await response.json());
}

/**
 * The entry for a peer as the agent runtime names it. An exact origin must match scheme, host
 * and port. The runtime passes only the host ("localhost:4101"), so a bare host is accepted
 * only when exactly one entry has it (http and https on one host would be ambiguous). The
 * page's fetch guard (peer-fetch.ts) then enforces the exact origin on every request.
 */
export function entryForPeer(entries: readonly DirectoryEntry[], peer: string): DirectoryEntry | undefined {
  const origin = exactOrigin(peer);
  if (origin !== null) return entries.find((e) => e.origin === origin);
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(peer)) return undefined;
  const matches = entries.filter((e) => new URL(e.origin).host === peer.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Label of a node's peer tool in the agent network (written by scripts/configure-nodes.mjs as
 * link_labels). It carries the network name the runtime will ask the node for, so the consent
 * gate can show and check the network actually requested.
 */
export function peerLabel(entry: Pick<DirectoryEntry, "name" | "network">): string {
  return `${entry.name} (network ${entry.network})`;
}

/** The network name in a peer label, or null. */
export function networkFromPeerLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const match = /\(network ([A-Za-z][A-Za-z0-9_]{0,63})\)$/.exec(label);
  return match ? match[1]! : null;
}
