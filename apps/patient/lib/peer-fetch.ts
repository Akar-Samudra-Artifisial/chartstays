// Guards the agent runtime's own requests to trial nodes. The vendored runtime fetches a peer's
// manifest, network and links with a plain fetch() (public/runtime/remote.js), so the app wraps
// the page's fetch before the runtime boots: every request to a directory node's origin is a
// plain GET without credentials, referrer or redirects, with a size cap and a timeout. The
// node's agent-manifest.json is also stripped of its "actions" block, so the runtime never
// opens the node's action bridge (an iframe or popup) on this page.
import { exactOrigin } from "./directory.ts";
import type { AgentFirewall, NodeJsonFile } from "./firewall.ts";
import { NodeLoadError, readCapped } from "./node-loader.ts";
import type { TrustLog } from "./trust-log.ts";

export const PEER_LIMITS = { maxBytes: 1024 * 1024, manifestBytes: 64 * 1024, timeoutMs: 15_000 } as const;

const MARK = Symbol.for("chartstays.peerFetch");

export interface PeerFetchOptions {
  /** Exact origins of the directory's trial nodes. */
  origins: readonly string[];
  log?: TrustLog;
  /** Scans each request before it leaves and inspects the node's manifest and network. */
  firewall?: AgentFirewall;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * In-page LLM router (lib/webllm-adapter.ts): requests whose URL starts with `prefix` are
   * answered by `handle` and never reach the network.
   */
  localRouter?: { prefix: string; handle: (url: string, init?: RequestInit) => Promise<Response> };
}

/** Manifest keys about running or routing models, keys or tools; a peer never decides those here. */
const ROUTER_KEY = /router|byok|api_?key|llm|model|coded_tools|mcp/i;

/**
 * A peer manifest without the parts this app never uses from a node: its action bridge, its
 * LLM router and other router, key, model or tool-bundle settings.
 */
export function sanitizePeerManifest(manifest: unknown): unknown {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return manifest;
  return Object.fromEntries(Object.entries(manifest as Record<string, unknown>).filter(([k]) => k !== "actions" && !ROUTER_KEY.test(k)));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** What the firewall inspects a node file as, by its path. Anything else must be JSON and is inspected as "other". */
function fileKind(url: URL): NodeJsonFile {
  if (url.pathname.endsWith("/agent-manifest.json")) return "agent-manifest.json";
  if (url.pathname.endsWith(".network.json")) return "network.json";
  if (url.pathname === "/links.json") return "links.json";
  return "other";
}

/** fetch() that applies the peer rules to requests for `origins` and passes the rest through. */
export function createPeerFetch(base: typeof fetch, options: PeerFetchOptions): typeof fetch {
  const origins = new Set(options.origins.map((o) => exactOrigin(o)).filter((o): o is string => o !== null));
  const maxBytes = options.maxBytes ?? PEER_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? PEER_LIMITS.timeoutMs;

  const local = options.localRouter;
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (local !== undefined) {
      const raw = requestUrl(input);
      if (raw === local.prefix || raw.startsWith(`${local.prefix}/`)) return local.handle(raw, init);
    }
    let url: URL;
    try {
      url = new URL(requestUrl(input), globalThis.location?.href);
    } catch {
      return base(input, init);
    }
    if (!origins.has(url.origin)) return base(input, init);

    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const path = url.pathname;
    const fail = (detail: string): never => {
      options.log?.record({ type: "contact", origin: url.origin, path, status: "error", detail });
      throw new TypeError(`Request to ${url.origin}${path} blocked: ${detail}`);
    };
    if (method !== "GET") fail(`only GET is allowed to a trial node (got ${method})`);
    const firewall = options.firewall;
    let phiFields = 0;
    if (firewall !== undefined) {
      // Nothing is sent to a quarantined node, nor a URL that carries health data.
      const out = await firewall.checkOutbound(url.origin, "request_url", url.href, method);
      const [first] = out.findings;
      if (first !== undefined) throw new TypeError(`Request to ${url.origin}${path} blocked by the Agent Firewall (${first.rule}): ${first.reason}`);
      phiFields = out.scan?.spans.length ?? 0;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    init?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      let response: Response;
      try {
        response = await base(url.href, {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          mode: "cors",
          signal: controller.signal,
        });
      } catch (error) {
        return fail(controller.signal.aborted ? "timed out or cancelled" : `network error or redirect (${error instanceof Error ? error.message : String(error)})`);
      }
      if (response.redirected || response.type === "opaqueredirect") {
        firewall?.inspectResponse(url.origin, path, { tooLarge: false, redirected: true });
        fail("the node redirected");
      }
      const kind = fileKind(url);
      const cap = kind === "agent-manifest.json" ? Math.min(maxBytes, PEER_LIMITS.manifestBytes) : maxBytes;
      let text: string;
      try {
        text = response.ok ? await readCapped(response, cap) : "";
      } catch (error) {
        if (error instanceof NodeLoadError && error.code === "too_large") firewall?.inspectResponse(url.origin, path, { tooLarge: true, redirected: false });
        return fail(error instanceof Error ? error.message : String(error));
      }
      const bytes = new TextEncoder().encode(text).byteLength;
      if (response.ok) {
        // Every body from a node is JSON and goes through the firewall before the runtime sees it:
        // the manifest, the network (the node assistant's instructions), links.json and any other file.
        let doc: unknown;
        try {
          doc = JSON.parse(text);
        } catch {
          fail(`${path} is not JSON; only a node's JSON files are read`);
        }
        if (firewall !== undefined) {
          const inspected = firewall.inspectJson(url.origin, kind, doc);
          if (inspected.quarantined) fail("the node is quarantined by the Agent Firewall");
          doc = inspected.value;
        }
        text = JSON.stringify(kind === "agent-manifest.json" ? sanitizePeerManifest(doc) : doc);
      }
      const query = url.search.length > 1 ? url.search : "";
      options.log?.record({
        type: "contact",
        origin: url.origin,
        path,
        status: response.ok ? "ok" : "error",
        bytes,
        phiFields,
        ...(query !== "" ? { query: firewall !== undefined ? await firewall.redactForLog(query) : "[not shown]", queryLength: query.length } : {}),
        ...(response.ok ? {} : { detail: `HTTP ${response.status}` }),
      });
      const headers = new Headers();
      const type = response.headers.get("content-type");
      if (type !== null) headers.set("content-type", type);
      return new Response(response.ok ? text : null, { status: response.status, statusText: response.statusText, headers });
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", abort);
    }
  };
  Object.defineProperty(guarded, MARK, { value: true });
  return guarded as typeof fetch;
}

/** Replace globalThis.fetch with the guarded one (once) and lock it. Call before the runtime boots. */
export function installPeerFetch(target: { fetch: typeof fetch }, options: PeerFetchOptions): void {
  if ((target.fetch as unknown as Record<symbol, unknown>)[MARK] === true) return;
  const guarded = createPeerFetch(target.fetch.bind(target), options);
  Object.defineProperty(target, "fetch", { value: guarded, writable: false, configurable: false, enumerable: true });
  if (target.fetch !== guarded) throw new Error("Could not install the trial node request guard.");
}
