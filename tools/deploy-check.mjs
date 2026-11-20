// pnpm deploy:check: build the Cloudflare Pages deployment and check it. Deploys nothing.
//
//   pnpm deploy:check                                  (config: apps/patient/config/nodes.prod.example.json)
//   CHARTSTAYS_NODES_CONFIG=<file> pnpm deploy:check   (another config marked "production": true)
//   pnpm deploy:check --no-build                       (check an existing dist/deploy again)
//
// 1. pnpm -r build with the production config (CHARTSTAYS_PRODUCTION=1: configure-nodes fails on
//    any http/localhost origin, demo/test node or missing "production": true) and pnpm gen.
// 2. dist/deploy/<project>/: the app export (moved from apps/patient/out) and a copy of each
//    configured dist/nodes/<area>. Project names come from the https://<project>.pages.dev
//    origins (or a node's "project" / the config's "appProject").
// 3. Restores the development node files in apps/patient (public/directory.json, manifest,
//    HOCON, network), so pnpm validate keeps passing; apps/patient/out is gone, so run
//    pnpm -r build again before pnpm e2e or pnpm serve:app.
// 4. Checks: no /spike page, no "demo node" label and no loopback origin in the app, no
//    demo/test node, _headers in every folder, node CORS readable from the app origin, node
//    Referrer-Policy no-referrer, no "demo node" in node files other than HTML pages, the
//    sandbox worker locked down, and directory/manifest/CSP equal to the config.
// 5. Prints the wrangler pages deploy command for each folder (run outside the workspace, --force).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Rules of a Cloudflare Pages _headers file: [{ pattern, lines: [[name, value] | ["!", name]] }]. */
async function readHeaderRules(dir) {
  const rules = [];
  let current = null;
  for (const line of (await readFile(path.join(dir, "_headers"), "utf8")).split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), lines: [] };
      rules.push(current);
    } else if (current && line.trim().startsWith("!")) {
      current.lines.push(["!", line.trim().slice(1).trim()]);
    } else if (current) {
      const i = line.indexOf(":");
      current.lines.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

/**
 * Headers for a path as Cloudflare Pages applies _headers: "*" is a splat anywhere in the
 * pattern, rules apply in file order, repeated headers are joined with ", " and "! name"
 * removes what earlier rules added.
 */
function headersFor(rules, urlPath) {
  const out = {};
  for (const rule of rules) {
    const re = new RegExp(`^${rule.pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (!re.test(urlPath)) continue;
    for (const [name, value] of rule.lines) {
      if (name === "!") delete out[value];
      else out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
    }
  }
  return out;
}

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const APP_DIR = path.join(ROOT, "apps/patient");
const APP_OUT = path.join(APP_DIR, "out");
const DIST_NODES = path.join(ROOT, "dist/nodes");
const DEPLOY = path.join(ROOT, "dist/deploy");
const DEFAULT_CONFIG = path.join(APP_DIR, "config/nodes.prod.example.json");
const PAGES_SUFFIX = ".pages.dev";
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,57}$/;
const SHADY_AREA = "shady-demo";
const FIXTURE_NETWORK_PREFIX = "fixture_";
const LOOPBACK_ORIGIN_RE = /(?:https?:)?\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?![a-z0-9.-])/i;
const TEXT_EXT = new Set([".html", ".txt", ".js", ".mjs", ".json", ".css", ".hocon", ".svg", ""]);
// Vendored files, copied unchanged (vendor/agentic-web runtime, @mlc-ai/web-llm): their router
// lists include local Ollama, which the production CSP does not allow (connect-src).
const VENDORED = ["runtime/", "webllm/web-llm.js"];
const WORKER_CSP = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'";

const failures = [];
const problem = (message) => failures.push(message);

function die(message) {
  console.error(`deploy:check: ${message}`);
  process.exit(1);
}

/** Runs a command; the node config comes only from `env` (never from the caller's environment). */
function run(cmd, args, env = {}) {
  console.log(`\n$ ${Object.entries(env).map(([k, v]) => `${k}=${v} `).join("")}${cmd} ${args.join(" ")}`);
  const { CHARTSTAYS_NODES_CONFIG: _config, CHARTSTAYS_PRODUCTION: _production, ...base } = process.env;
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...base, ...env } });
  return result.status === 0;
}

function projectName(origin, explicit, where) {
  const name = explicit ?? (new URL(origin).hostname.endsWith(PAGES_SUFFIX) ? new URL(origin).hostname.slice(0, -PAGES_SUFFIX.length) : null);
  if (typeof name !== "string" || !PROJECT_RE.test(name)) {
    die(`${where}: cannot derive a Cloudflare Pages project name from ${origin}; use https://<project>.pages.dev or set "project"`);
  }
  return name;
}

async function files(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** Text files of a deploy folder, without the vendored ones. */
async function ownTextFiles(dir) {
  return (await files(dir)).filter((f) => TEXT_EXT.has(path.extname(f)) && !VENDORED.some((v) => f === v || f.startsWith(v)));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function checkApp(dir, config, appOrigin) {
  const label = `app (${path.relative(ROOT, dir)})`;
  if (!existsSync(path.join(dir, "_headers"))) return problem(`${label}: _headers is missing`);
  const all = await files(dir);
  const spike = all.filter((f) => /(^|\/)spike(\.|\/|$)/.test(f));
  if (spike.length) problem(`${label}: development page /spike is in the export: ${spike.join(", ")}`);
  const headersText = await readFile(path.join(dir, "_headers"), "utf8");
  if (/^\/spike/m.test(headersText)) problem(`${label}: _headers has a /spike rule`);
  for (const f of await ownTextFiles(dir)) {
    const text = await readFile(path.join(dir, f), "utf8");
    if (/demo node/i.test(text)) problem(`${label}: ${f} says "demo node"`);
    const loop = text.match(LOOPBACK_ORIGIN_RE);
    if (loop) problem(`${label}: ${f} has the loopback origin ${loop[0]}`);
  }

  const expected = config.nodes.map((n) => ({ name: n.name, origin: n.origin, area: n.area, network: n.network }));
  const directory = await readJson(path.join(dir, "directory.json"));
  if (JSON.stringify(directory.nodes) !== JSON.stringify(expected)) problem(`${label}: directory.json does not equal the config's nodes`);
  const manifest = await readJson(path.join(dir, "agent-manifest.json"));
  if (JSON.stringify(manifest.allowed_peers) !== JSON.stringify(expected.map((n) => n.origin))) problem(`${label}: agent-manifest.json allowed_peers do not equal the node origins`);

  const rules = await readHeaderRules(dir);
  for (const page of ["/", "/match"]) {
    const csp = headersFor(rules, page)["Content-Security-Policy"] ?? "";
    const connect = (csp.match(/connect-src ([^;]*)/) ?? [])[1]?.split(/\s+/) ?? [];
    if (!csp) problem(`${label}: no Content-Security-Policy for ${page}`);
    for (const n of expected) if (!connect.includes(n.origin)) problem(`${label}: CSP connect-src for ${page} lacks ${n.origin}`);
    if (connect.some((s) => s.startsWith("http:") || LOOPBACK_ORIGIN_RE.test(s))) problem(`${label}: CSP connect-src for ${page} allows http or localhost: ${connect.join(" ")}`);
    if (/'unsafe-eval'/.test(csp)) problem(`${label}: CSP for ${page} allows 'unsafe-eval'`);
  }
  if (headersFor(rules, "/runtime/sandbox-worker.js")["Content-Security-Policy"] !== WORKER_CSP) problem(`${label}: /runtime/sandbox-worker.js CSP is not the sandbox policy`);
  if (!/https:\/\/huggingface\.co/.test(headersFor(rules, "/webllm/worker.js")["Content-Security-Policy"] ?? "")) problem(`${label}: /webllm/* CSP does not allow the pinned model download`);
  console.log(`deploy:check: ${label} ${appOrigin}: checked ${all.length} files`);
}

async function checkNode(dir, node, appOrigin) {
  const label = `node ${node.area} (${path.relative(ROOT, dir)})`;
  if (node.area === SHADY_AREA || node.network.startsWith(FIXTURE_NETWORK_PREFIX) || node.demo || node.test) return problem(`${label}: demo/test node in a deployment`);
  for (const required of ["_headers", "index.html", "agent-manifest.json", "links.json", "criteria/index.json", "runtime/sandbox-worker.js"]) {
    if (!existsSync(path.join(dir, required))) problem(`${label}: ${required} is missing`);
  }
  if (!existsSync(path.join(dir, "_headers"))) return;
  const rules = await readHeaderRules(dir);
  const network = `/${node.network}.network.json`;
  for (const p of ["/agent-manifest.json", "/links.json", network, "/criteria/index.json", "/logistics/x.json", "/.well-known/x"]) {
    const allow = headersFor(rules, p)["Access-Control-Allow-Origin"];
    if (allow !== "*" && allow !== appOrigin) problem(`${label}: ${p} is not readable from ${appOrigin} (Access-Control-Allow-Origin: ${allow ?? "none"})`);
  }
  if (headersFor(rules, "/runtime/sandbox-worker.js")["Content-Security-Policy"] !== WORKER_CSP) problem(`${label}: /runtime/sandbox-worker.js CSP is not the sandbox policy`);
  for (const p of ["/", network, "/criteria/index.json"]) {
    const policy = headersFor(rules, p)["Referrer-Policy"];
    if (policy !== "no-referrer") problem(`${label}: ${p} has Referrer-Policy ${policy ?? "none"}, expected no-referrer`);
  }
  for (const f of await ownTextFiles(dir)) {
    const text = await readFile(path.join(dir, f), "utf8");
    const loop = text.match(LOOPBACK_ORIGIN_RE);
    if (loop) problem(`${label}: ${f} has the loopback origin ${loop[0]}`);
    // The node's own HTML page may say "Demo node"; the files the app and its assistant read may not.
    if (!f.endsWith(".html") && /demo node/i.test(text)) problem(`${label}: ${f} says "demo node"`);
  }
  console.log(`deploy:check: ${label}: checked`);
}

async function main() {
  const configPath = path.resolve(process.env.CHARTSTAYS_NODES_CONFIG ?? DEFAULT_CONFIG);
  const config = await readJson(configPath).catch((error) => die(`cannot read ${configPath}: ${error.message}`));
  if (config.production !== true) die(`${path.relative(ROOT, configPath)} is not marked "production": true`);
  if (!Array.isArray(config.nodes) || config.nodes.length === 0) die(`${path.relative(ROOT, configPath)}: expected {"nodes": [...]}`);
  let appOrigin;
  try {
    appOrigin = new URL(config.app).origin;
  } catch {
    die(`${path.relative(ROOT, configPath)}: "app" must be the app's https origin`);
  }
  const appProject = projectName(appOrigin, config.appProject, "app");
  const targets = config.nodes.map((n, i) => ({ node: n, project: projectName(n.origin, n.project, `nodes[${i}]`) }));
  const projects = [appProject, ...targets.map((t) => t.project)];
  if (new Set(projects).size !== projects.length) die(`project names must be distinct: ${projects.join(", ")}`);

  if (!process.argv.includes("--no-build")) {
    const env = { CHARTSTAYS_NODES_CONFIG: configPath, CHARTSTAYS_PRODUCTION: "1" };
    let built = false;
    // A failed build must not leave an older dist/deploy behind to be deployed by mistake.
    await rm(DEPLOY, { recursive: true, force: true });
    try {
      built = run("pnpm", ["-r", "build"], env) && run("pnpm", ["gen"]);
      if (built) {
        await mkdir(DEPLOY, { recursive: true });
        await rename(APP_OUT, path.join(DEPLOY, appProject));
        for (const { node, project } of targets) {
          const src = path.join(DIST_NODES, node.area);
          if (!existsSync(src)) die(`dist/nodes/${node.area} does not exist (pnpm gen writes the configured areas)`);
          await cp(src, path.join(DEPLOY, project), { recursive: true });
        }
      }
    } finally {
      // Back to the development node files (pnpm validate checks them against nodes.dev.json).
      const restored = run("node", [path.join(APP_DIR, "scripts/configure-nodes.mjs")]) && run("pnpm", ["--filter", "@chartstays/patient", "run", "build:network"]);
      if (!restored) console.error("deploy:check: could not restore the development node files; run pnpm --filter @chartstays/patient prebuild");
    }
    if (!built) die("the production build failed (see above); nothing was assembled");
  }

  if (!existsSync(DEPLOY)) die("dist/deploy does not exist; run pnpm deploy:check without --no-build");
  const present = (await readdir(DEPLOY)).filter((e) => !e.startsWith("."));
  const extra = present.filter((e) => !projects.includes(e));
  if (extra.length) problem(`dist/deploy has folders that are not in the config: ${extra.join(", ")}`);
  for (const p of projects) if (!present.includes(p)) problem(`dist/deploy/${p} is missing`);
  if (present.includes(appProject)) await checkApp(path.join(DEPLOY, appProject), config, appOrigin);
  for (const { node, project } of targets) if (present.includes(project)) await checkNode(path.join(DEPLOY, project), node, appOrigin);

  if (failures.length) {
    console.error(`\ndeploy:check: FAILED (${failures.length})`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\ndeploy:check: OK. Deploy with (after npx wrangler login and creating the projects).");
  console.log("wrangler 4.164 redirects `pages` commands to Workers and fails at this workspace root, so run");
  console.log("from a directory outside the workspace, with --force (Pages deploy without the redirect):");
  console.log(`  mkdir -p /tmp/cs-wr && cd /tmp/cs-wr`);
  for (const p of projects) console.log(`  npx wrangler@latest pages deploy ${path.join(DEPLOY, p)} --project-name ${p} --branch main --commit-dirty=true --force`);
}

main().catch((error) => die(error instanceof Error ? error.stack ?? error.message : String(error)));
