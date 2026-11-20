// pnpm serve:app: serve the static export apps/patient/out on http://localhost:4000 (bound to
// 127.0.0.1) with the headers from its _headers file applied as Cloudflare Pages does (CSP on,
// including the /webllm/* rule for the local model worker). Local development only; the e2e
// test (tools/e2e/patient-e2e.mjs) uses the same server.
//
//   pnpm -r build && pnpm gen
//   pnpm serve:app                   (Ctrl+C stops it)
//   pnpm serve:app --overlay <dir>   (files from a configure-nodes.mjs --overlay folder, its
//                                     _headers included, win over out/)
//
// "/page/" redirects (308) to "/page" when page.html exists, as on Cloudflare Pages.
// The command line version logs one line per request (status, method, path; no query string).
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const OUT = path.join(ROOT, "apps/patient/out");
export const APP_PORT = 4000;
export const APP = `http://localhost:${APP_PORT}`;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Rules of a Cloudflare Pages _headers file: [{ pattern, headers }]. */
export async function readHeaderRules(dir) {
  const rules = [];
  let current = null;
  for (const line of (await readFile(path.join(dir, "_headers"), "utf8")).split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(":");
      current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

/** Headers for a path, as Cloudflare Pages applies them: every matching rule, values joined. */
export function headersFor(rules, urlPath) {
  const out = {};
  for (const rule of rules) {
    const match = rule.pattern.endsWith("*") ? urlPath.startsWith(rule.pattern.slice(0, -1)) : urlPath === rule.pattern;
    if (!match) continue;
    for (const [name, value] of rule.headers) out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}

/**
 * Serve apps/patient/out on 127.0.0.1:4000. With `overlay` (a configure-nodes.mjs --overlay
 * folder) its files, including _headers, win over out/: the same export for another node config.
 * `onRequest(status, method, urlPath)` is called once per answered request.
 */
export async function serveApp(overlay = null, { onRequest } = {}) {
  const rules = await readHeaderRules(overlay ?? OUT);
  const roots = overlay === null ? [OUT] : [overlay, OUT];
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? "/", APP).pathname);
    const candidates = urlPath === "/" ? ["index.html"] : [urlPath.slice(1), `${urlPath.slice(1)}.html`, path.join(urlPath.slice(1), "index.html")];
    for (const [root, rel] of roots.flatMap((r) => candidates.map((c) => [r, c]))) {
      const file = path.join(root, rel);
      if (!file.startsWith(`${root}${path.sep}`) || rel === "_headers" || rel.endsWith(".hocon")) continue;
      try {
        if (!(await stat(file)).isFile()) continue;
      } catch {
        continue;
      }
      const headers = { ...headersFor(rules, urlPath), "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" };
      res.writeHead(200, headers);
      res.end(await readFile(file));
      onRequest?.(200, req.method, urlPath);
      return;
    }
    // "/match/" → 308 "/match" when match.html exists, as Cloudflare Pages does, so the page gets
    // its own _headers rule (CSP with the page's script hashes).
    if (urlPath.length > 1 && urlPath.endsWith("/")) {
      const bare = urlPath.slice(0, -1);
      for (const root of roots) {
        const file = path.join(root, `${bare.slice(1)}.html`);
        if (!file.startsWith(`${root}${path.sep}`)) continue;
        const isFile = await stat(file).then((s) => s.isFile(), () => false);
        if (!isFile) continue;
        res.writeHead(308, { Location: `${bare}${new URL(req.url ?? "/", APP).search}`, "Cache-Control": "no-store" });
        res.end();
        onRequest?.(308, req.method, urlPath);
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    onRequest?.(404, req.method, urlPath);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(APP_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const overlayIndex = process.argv.indexOf("--overlay");
  const overlay = overlayIndex === -1 ? null : process.argv[overlayIndex + 1];
  if (overlayIndex !== -1 && !overlay) {
    console.error("--overlay needs a directory");
    process.exit(1);
  }
  try {
    await stat(path.join(OUT, "_headers"));
  } catch {
    console.error(`${OUT} has no _headers. Run pnpm -r build && pnpm gen first.`);
    process.exit(1);
  }
  let server;
  try {
    server = await serveApp(overlay === null ? null : path.resolve(overlay), {
      onRequest: (status, method, urlPath) => console.log(`${new Date().toISOString().slice(11, 19)} ${status} ${method} ${urlPath}`),
    });
  } catch (error) {
    console.error(`Could not serve on port ${APP_PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`patient app: ${APP}/ (from ${overlay === null ? OUT : `${path.resolve(overlay)} over ${OUT}`}). Stop with Ctrl+C.`);
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
