// pnpm serve:nodes: serve every generated node in dist/nodes on its own localhost port
// (4101-4104, from tools/node-generator/src/areas.ts). Local development only.
//
// CORS mirrors the _headers file each node ships: JSON files and the agent folders get
// Access-Control-Allow-Origin: *, so the patient app on another origin can read them.
// Stop with Ctrl+C.
//
// --log <file>: append one JSON line per request (port, method, url, headers, body) for tests
// that check what the patient app sends to the nodes.
//
// --demo: also serve the DEMO / ADVERSARIAL shady node on 4105 (dist/demo-nodes/shady-demo).
// Each node's _redirects file (Cloudflare Pages format, exact paths) is honoured.

import { appendFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AREAS } from "./node-generator/src/areas.ts";
import { SHADY_AREA } from "./node-generator/src/shady.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../dist/nodes/", import.meta.url)));
/** The shady node lives outside dist/nodes, so deploying dist/nodes never includes it. */
const DEMO_ROOT = path.resolve(fileURLToPath(new URL("../dist/demo-nodes/", import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};
// The runtime's sandbox worker runs model-written code; keep it without network access.
const WORKER_CSP = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'";
const logIndex = process.argv.indexOf("--log");
const LOG_FILE = logIndex === -1 ? null : process.argv[logIndex + 1];
if (logIndex !== -1 && !LOG_FILE) {
  console.error("--log needs a file path");
  process.exit(1);
}
const MAX_LOGGED_BODY = 64 * 1024;
// --test-redirect <url>: /__test/redirect.json answers 302 to <url> (e2e: the patient app must
// refuse a node's cross-origin redirect).
const redirectIndex = process.argv.indexOf("--test-redirect");
const TEST_REDIRECT = redirectIndex === -1 ? null : process.argv[redirectIndex + 1];
if (redirectIndex !== -1 && !TEST_REDIRECT) {
  console.error("--test-redirect needs a URL");
  process.exit(1);
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_LOGGED_BODY) chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

const CORS_PREFIXES = ["/criteria/", "/logistics/", "/.well-known/", "/bridge/"];

function allowsAnyOrigin(urlPath) {
  return urlPath.endsWith(".json") || CORS_PREFIXES.some((prefix) => urlPath.startsWith(prefix));
}

async function resolveFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const target = path.join(root, decoded);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  for (const candidate of [target, path.join(target, "index.html")]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Exact-path rules from a node's Cloudflare Pages _redirects file ("/from https://to 302"). */
async function readRedirects(root) {
  const rules = new Map();
  let text;
  try {
    text = await readFile(path.join(root, "_redirects"), "utf8");
  } catch {
    return rules;
  }
  for (const line of text.split("\n")) {
    const [from, to, status] = line.trim().split(/\s+/);
    if (!from || from.startsWith("#") || !to) continue;
    rules.set(from, { to, status: Number(status) || 302 });
  }
  return rules;
}

function serve(root, port, redirects) {
  const server = http.createServer(async (request, response) => {
    if (LOG_FILE) {
      const body = await readBody(request);
      appendFileSync(LOG_FILE, `${JSON.stringify({ port, method: request.method, url: request.url, headers: request.headers, body })}\n`);
    }
    const urlPath = new URL(request.url ?? "/", "http://localhost").pathname;
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (allowsAnyOrigin(urlPath)) headers["Access-Control-Allow-Origin"] = "*";
    if (urlPath.endsWith("/runtime/sandbox-worker.js")) headers["Content-Security-Policy"] = WORKER_CSP;
    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" });
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...headers, Allow: "GET, HEAD, OPTIONS" });
      response.end("Method not allowed");
      return;
    }
    if (TEST_REDIRECT && urlPath === "/__test/redirect.json") {
      response.writeHead(302, { ...headers, Location: TEST_REDIRECT });
      response.end();
      return;
    }
    const redirect = redirects.get(urlPath);
    if (redirect) {
      response.writeHead(redirect.status, { ...headers, Location: redirect.to });
      response.end();
      return;
    }
    const file = await resolveFile(root, urlPath);
    if (!file) {
      response.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    headers["Content-Type"] = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : await readFile(file));
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const servers = [];
// --demo also serves the DEMO / ADVERSARIAL shady node (Agent Firewall demo, config/nodes.demo.json).
const areas = process.argv.includes("--demo") ? [...AREAS, SHADY_AREA] : AREAS;
for (const area of areas) {
  const root = path.join(area === SHADY_AREA ? DEMO_ROOT : ROOT, area.slug);
  try {
    await stat(path.join(root, "index.html"));
  } catch {
    console.error(`${root} has no index.html. Run pnpm gen first.`);
    process.exit(1);
  }
  const server = serve(root, area.port, await readRedirects(root));
  server.on("error", (error) => {
    console.error(`${area.slug} on port ${area.port}: ${error.message}`);
    process.exit(1);
  });
  servers.push(server);
  console.log(`${area.slug}: http://localhost:${area.port}/ (network ${area.network})`);
}

function stop() {
  for (const server of servers) server.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
