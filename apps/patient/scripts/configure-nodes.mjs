// Fill in the trial node base URLs at build time, from config/nodes.dev.json or the file
// named by CHARTSTAYS_NODES_CONFIG. Writes:
//   public/directory.json            the node directory the app and its agents read
//   agent/patient_navigator.hocon    from agent/patient_navigator.hocon.tmpl (peer tools, labels)
//   public/agent-manifest.json       allowed_peers = the node origins
// With --check it writes nothing and exits 1 when a file is missing or out of date.
// With --overlay <dir> it writes those files for another config into <dir> (see writeOverlay).
// Nodes marked "demo": true (the adversarial Agent Firewall demo node) are refused unless the
// config itself is marked "demo": true (config/nodes.demo.json). Likewise nodes marked
// "test": true (the interop fixtures, tools/e2e/interop-fixtures.mjs) need a config marked "test".
// With --headers (after next build) it writes out/_headers for Cloudflare Pages: security
// headers and a Content-Security-Policy whose connect-src lists the configured nodes.
// Without CHARTSTAYS_NODES_CONFIG it uses config/nodes.dev.json and prints a warning.
// A config marked "production": true is checked for deployment (see checkProduction).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEMPLATE = path.join(APP, "agent/patient_navigator.hocon.tmpl");
const HOCON = path.join(APP, "agent/patient_navigator.hocon");
const DIRECTORY = path.join(APP, "public/directory.json");
const MANIFEST = path.join(APP, "public/agent-manifest.json");
const OUT = path.join(APP, "out");
const BUILD_NETWORK = path.resolve(APP, "../../vendor/agentic-web/skills/agentify-website/scripts/build_network.mjs");
const MAX_NODES = 8;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NETWORK_RE = /^[a-z][a-z0-9_]{0,63}$/;
const AREA_RE = /^[a-z0-9-]{1,64}$/;

function fail(message) {
  console.error(`configure-nodes: ${message}`);
  process.exit(1);
}

function exactOrigin(value, where) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    fail(`${where}: "${value}" is not a URL`);
  }
  if (url.origin !== value) fail(`${where}: "${value}" must be an exact origin (scheme, host and port; no path or trailing slash)`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) fail(`${where}: "${value}" must use https (http only on localhost)`);
  return url.origin;
}

function readNodes(config, source) {
  if (!config || !Array.isArray(config.nodes) || config.nodes.length === 0) fail(`${source}: expected {"nodes": [...]}`);
  if (config.nodes.length > MAX_NODES) fail(`${source}: at most ${MAX_NODES} nodes`);
  if (config.demo !== undefined && config.demo !== true) fail(`${source}: "demo" must be true when set`);
  if (config.dev !== undefined && config.dev !== true) fail(`${source}: "dev" must be true when set`);
  if (config.test !== undefined && config.test !== true) fail(`${source}: "test" must be true when set`);
  const origins = new Set();
  const networks = new Set();
  const nodes = config.nodes.map((node, i) => {
    const where = `${source} nodes[${i}]`;
    const origin = exactOrigin(node.origin, where);
    if (typeof node.name !== "string" || !node.name.trim() || node.name.length > 120 || /["\\\n]/.test(node.name)) fail(`${where}: name is required (no quotes or backslashes)`);
    if (typeof node.area !== "string" || !AREA_RE.test(node.area)) fail(`${where}: area must match ${AREA_RE}`);
    if (typeof node.network !== "string" || !NETWORK_RE.test(node.network)) fail(`${where}: network must match ${NETWORK_RE}`);
    if (origins.has(origin)) fail(`${where}: duplicate origin ${origin}`);
    if (networks.has(node.network)) fail(`${where}: duplicate network ${node.network}`);
    if (node.demo !== undefined && node.demo !== true) fail(`${where}: "demo" must be true when set`);
    // Adversarial demo nodes (the Agent Firewall demo) only load from a config marked "demo": true.
    if (node.demo === true && config.demo !== true) fail(`${where}: demo node ${origin} is only allowed in a config marked "demo": true`);
    if (node.test !== undefined && node.test !== true) fail(`${where}: "test" must be true when set`);
    // TEST-ONLY interop fixtures (tools/e2e/interop-fixtures.mjs) only load from a config marked "test": true.
    if (node.test === true && config.test !== true) fail(`${where}: test fixture node ${origin} is only allowed in a config marked "test": true`);
    origins.add(origin);
    networks.add(node.network);
    const entry = { name: node.name, origin, area: node.area, network: node.network };
    const marked = node.demo === true ? { ...entry, demo: true } : entry;
    return node.test === true ? { ...marked, test: true } : marked;
  });
  const loopback = nodes.filter((n) => LOOPBACK.has(new URL(n.origin).hostname)).map((n) => n.origin);
  // A demo or test config is for this machine only: every node on localhost.
  if (config.demo === true && loopback.length !== nodes.length) fail(`${source}: a config marked "demo": true may list only localhost nodes`);
  if (config.test === true && loopback.length !== nodes.length) fail(`${source}: a config marked "test": true may list only localhost nodes`);
  // localhost nodes in a build meant for deployment would be a broken (or local-network-probing) site.
  if (loopback.length > 0 && config.dev !== true && config.demo !== true && config.test !== true) {
    fail(`${source}: localhost origins (${loopback.join(", ")}) are only allowed in a config marked "dev": true (development), "demo": true or "test": true`);
  }
  checkProduction(config, nodes, source);
  return nodes;
}

/**
 * A config marked "production": true (config/nodes.prod.example.json) is for a deployment:
 * https only, no loopback host, no demo or test node, no "demo node" label, and an "app" origin.
 * CHARTSTAYS_PRODUCTION=1 (set by pnpm deploy:check) requires such a config.
 */
function checkProduction(config, nodes, source) {
  if (config.production !== undefined && config.production !== true) fail(`${source}: "production" must be true when set`);
  if (process.env.CHARTSTAYS_PRODUCTION === "1" && config.production !== true) {
    fail(`${source}: CHARTSTAYS_PRODUCTION=1 needs a config marked "production": true (see config/nodes.prod.example.json)`);
  }
  if (config.production !== true) return;
  for (const flag of ["dev", "demo", "test"]) {
    if (config[flag] !== undefined) fail(`${source}: a config marked "production": true cannot also be marked "${flag}"`);
  }
  const app = exactOrigin(config.app, `${source} app`);
  const origins = [app, ...nodes.map((n) => n.origin)];
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || LOOPBACK.has(url.hostname)) fail(`${source}: production origin ${origin} must be https and not localhost`);
  }
  if (nodes.some((n) => n.origin === app)) fail(`${source}: the app origin ${app} cannot also be a node origin`);
  for (const n of nodes) {
    if (n.demo === true || n.test === true) fail(`${source}: production config lists a demo or test node (${n.origin})`);
    if (/demo node|localhost/i.test(n.name)) fail(`${source}: production node name "${n.name}" must not say "demo node" or "localhost"`);
  }
}

function renderHocon(template, nodes) {
  const indent = "        ";
  // The label carries the network name: the app's consent gate (lib/runtime-consent.ts) reads it
  // back from the runtime's consent request and checks it against the directory.
  const labels = nodes.map((n) => `${indent}"${n.origin}/${n.network}": "${n.name} (network ${n.network})"`).join(",\n");
  const tools = `[${nodes.map((n) => `"${n.origin}/${n.network}"`).join(", ")}]`;
  const list = nodes.map((n) => `- ${n.network}: ${n.name}, ${n.origin}`).join("\n");
  const out = template
    .replace("{{NODE_LINK_LABELS}}", labels)
    .replace("{{NODE_TOOLS}}", tools)
    .replace("{{NODE_LIST}}", list);
  if (out.includes("{{")) fail("the HOCON template has an unknown {{placeholder}}");
  const header = "# GENERATED by scripts/configure-nodes.mjs from patient_navigator.hocon.tmpl. Do not edit.\n";
  return header + out;
}

/** LLM routers the agent runtime may call (public/runtime/ui.js router list), for connect-src. */
const ROUTER_ORIGINS = ["https://api.otari.ai", "https://openrouter.ai", "https://api.anthropic.com", "https://api.openai.com"];
/** Local Ollama, allowed only when every node is on localhost (a development build). */
const DEV_ROUTER_ORIGINS = ["http://localhost:11434", "http://127.0.0.1:11434"];

function sha256(text) {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** Hashes of the inline <script> blocks Next writes into a page (RSC payload, bootstrap). */
function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].length > 0) hashes.add(sha256(match[1]));
  }
  return [...hashes];
}

export function contentSecurityPolicy(nodes, scriptHashes) {
  const dev = nodes.every((n) => LOOPBACK.has(new URL(n.origin).hostname));
  const connect = ["'self'", ...nodes.map((n) => n.origin), ...ROUTER_ORIGINS, ...(dev ? DEV_ROUTER_ORIGINS : [])];
  return [
    "default-src 'self'",
    // Next's static export inlines its bootstrap and RSC payload: allowed by hash, no
    // 'unsafe-inline' or 'unsafe-eval' for scripts.
    `script-src 'self' ${scriptHashes.join(" ")}`.trim(),
    // The agent runtime injects its own <style> elements (public/runtime/ui.js); styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    // The runtime's tool sandbox is a module worker that imports tool code from a blob: URL.
    "worker-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "manifest-src 'self'",
    // No frame-src: node action bridges are never opened (lib/peer-fetch.ts strips them).
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

const WORKER_CSP = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'";
// The model worker fetches pins.json and the WebGPU library from our origin ('self') and the
// pinned model files from huggingface.co. Large (LFS) files redirect from huggingface.co to the
// Xet CDN: measured 302 Location host us.aws.cdn.hf.co (path /xet-bridge-us/...). The region is
// part of the host name and chosen by Hugging Face per client, so the CDN is allowed as
// *.aws.cdn.hf.co rather than one region; no other hf.co host is allowed.
export const WEBLLM_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://*.aws.cdn.hf.co; worker-src 'none'";

const COMMON_HEADERS = [
  "Referrer-Policy: no-referrer",
  "X-Content-Type-Options: nosniff",
  "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy: same-origin",
];

/** Cloudflare Pages URL paths for an exported HTML file ("match.html" -> /match, /match.html). */
function pagePaths(rel) {
  const posix = rel.split(path.sep).join("/");
  if (posix === "index.html") return ["/", "/index.html"];
  if (posix.endsWith("/index.html")) {
    const dir = `/${posix.slice(0, -"index.html".length)}`;
    return [dir, dir.slice(0, -1), `/${posix}`];
  }
  return [`/${posix.slice(0, -".html".length)}`, `/${posix}`];
}

async function htmlFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full, base)));
    else if (entry.name.endsWith(".html")) out.push(path.relative(base, full));
  }
  return out.sort();
}

/**
 * The _headers file for the exported site: common headers on every path, and on each HTML page
 * a CSP with the hashes of that page's inline scripts. CSP is set per page only, because
 * Cloudflare Pages sends every matching rule and two CSP headers would both be enforced.
 */
export async function renderHeaders(nodes, outDir) {
  const lines = [
    "# GENERATED by scripts/configure-nodes.mjs --headers from the node config. Do not edit.",
    "/*",
    ...COMMON_HEADERS.map((h) => `  ${h}`),
    "",
    // The runtime's tool sandbox runs model-written code: no network access from it.
    "/runtime/sandbox-worker.js",
    `  Content-Security-Policy: ${WORKER_CSP}`,
    "",
    // The local model's worker (public/webllm/): it may compile WebAssembly and download only the
    // model files (Hugging Face and its CDN) and the model library (GitHub). The pages' CSP is
    // unchanged; patient data stays in the page and the worker's messages.
    "/webllm/*",
    `  Content-Security-Policy: ${WEBLLM_CSP}`,
    "",
  ];
  for (const rel of await htmlFiles(outDir)) {
    const csp = contentSecurityPolicy(nodes, inlineScriptHashes(await readFile(path.join(outDir, rel), "utf8")));
    for (const p of pagePaths(rel)) lines.push(p, `  Content-Security-Policy: ${csp}`, "");
  }
  return lines.join("\n");
}

function configPathOrDefault() {
  if (process.env.CHARTSTAYS_NODES_CONFIG) return path.resolve(process.env.CHARTSTAYS_NODES_CONFIG);
  console.warn("configure-nodes: CHARTSTAYS_NODES_CONFIG is not set; using config/nodes.dev.json (localhost nodes, for development only).");
  return path.join(APP, "config/nodes.dev.json");
}

/**
 * --overlay <dir> (after next build): write the node-dependent files for another node config
 * into <dir> instead of public/ and out/, leaving the tracked files untouched. A static server
 * that serves <dir> before out/ then runs the same export against that config (the e2e uses it
 * for config/nodes.demo.json). Writes directory.json, agent-manifest.json, the network JSON and
 * its discovery files (build_network), and _headers with the CSP for these nodes.
 */
async function writeOverlay(dir, nodes, { directory, hocon, manifestText }) {
  if (!dir || dir.startsWith("--")) fail("--overlay needs a directory");
  if (!existsSync(OUT)) fail(`${path.relative(process.cwd(), OUT)} does not exist; run next build first`);
  const target = path.resolve(dir);
  await mkdir(target, { recursive: true });
  const hoconFile = path.join(target, "patient_navigator.hocon");
  await writeFile(path.join(target, "directory.json"), directory);
  await writeFile(path.join(target, "agent-manifest.json"), manifestText);
  await writeFile(hoconFile, hocon);
  const build = spawnSync(
    process.execPath,
    [BUILD_NETWORK, hoconFile, "--manifest", path.join(target, "agent-manifest.json"), "--runtime", path.join(APP, "public/runtime"), "--out", path.join(target, "patient_navigator.network.json")],
    { cwd: APP, encoding: "utf8" },
  );
  if (build.status !== 0) fail(`build_network failed for the overlay:\n${build.stdout}${build.stderr}`);
  await writeFile(path.join(target, "_headers"), await renderHeaders(nodes, OUT));
  console.log(`configure-nodes: wrote the overlay for ${nodes.length} nodes to ${target}`);
}

async function main() {
  const check = process.argv.includes("--check");
  const configPath = configPathOrDefault();
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    fail(`cannot read the node config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const nodes = readNodes(config, path.relative(process.cwd(), configPath) || configPath);

  if (process.argv.includes("--headers")) {
    if (!existsSync(OUT)) fail(`${path.relative(process.cwd(), OUT)} does not exist; run next build first`);
    await writeFile(path.join(OUT, "_headers"), await renderHeaders(nodes, OUT));
    console.log(`configure-nodes: wrote out/_headers (CSP for ${nodes.length} nodes)`);
    return;
  }

  const directory = `${JSON.stringify({ version: 1, nodes }, null, 2)}\n`;
  const hocon = renderHocon(await readFile(TEMPLATE, "utf8"), nodes);
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  manifest.allowed_peers = nodes.map((n) => n.origin);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  const overlayIndex = process.argv.indexOf("--overlay");
  if (overlayIndex !== -1) {
    await writeOverlay(process.argv[overlayIndex + 1], nodes, { directory, hocon, manifestText });
    return;
  }

  const outputs = [
    [DIRECTORY, directory],
    [HOCON, hocon],
    [MANIFEST, manifestText],
  ];
  if (check) {
    const stale = [];
    for (const [file, text] of outputs) {
      let current = null;
      try {
        current = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
      } catch {
        // missing counts as stale
      }
      if (current !== text) stale.push(path.relative(APP, file));
    }
    if (stale.length) fail(`out of date with ${path.basename(configPath)}: ${stale.join(", ")}. Run pnpm --filter @chartstays/patient configure-nodes.`);
    console.log(`configure-nodes: ${nodes.length} nodes, outputs up to date`);
    return;
  }
  for (const [file, text] of outputs) await writeFile(file, text);
  console.log(`configure-nodes: ${nodes.length} nodes from ${path.relative(process.cwd(), configPath)}: ${nodes.map((n) => n.origin).join(", ")}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
