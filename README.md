# ChartStays

Your health record never leaves your browser; the clinical trials come to you.

This repository holds the ChartStays monorepo: a patient app (skeleton) and a generator that
turns real ClinicalTrials.gov records into four static **agentic trial node** sites. Each
node publishes its studies, machine-readable eligibility criteria and an in-page agent
network built on the [agentic-web](https://github.com/cognizant-ai-labs/agentic-web)
runtime.

> The trial nodes are demos, not real trial sites. They give pre-screening information
> only, not medical advice, and cannot enroll anyone.

## Structure

```
apps/patient/              Next.js patient app: FHIR import, local profile, dev preview (/spike: runtime spike, dev builds only)
packages/criteria-schema/  JSON Schema + TypeScript types for criteria.json, Ajv validator
packages/fhir-profile/     FHIR R4 Bundle -> de-identified patient profile (browser + Node, no network)
packages/matcher/          deterministic matcher: profile x criteria.json -> verdict + evidence (no network, no LLM)
packages/node-template/    page.html, node.css and site-actions.js shared by every node
tools/node-generator/      fetch, curate, generate and validate CLIs (TypeScript, run by Node)
tools/serve-nodes.mjs      local CORS server for dist/nodes (ports 4101-4104)
tools/synthea-subset.mjs   builds data/synthea from a Synthea sample download
vendor/agentic-web/        runtime + build_network.mjs, unchanged (see VENDOR.md)
data/ctgov/<area>/         ClinicalTrials.gov snapshots, one JSON file per study
data/curation/<area>.json  study list per area + hand-written criterion mappings
data/curated/              generated criteria documents (<NCT>.criteria.json)
data/synthea/              Synthea patient subset + code inventory (see its README)
data/demo-patients.json    one demo ("hero") patient per area, written by pnpm match:report
docs/match-matrix.md       patient x study matrix, written by pnpm match:report
dist/nodes/<area>/         generated node sites (not committed); the only node folders to deploy
dist/demo-nodes/shady-demo/ the DEMO / ADVERSARIAL node, local demo only (never deploy)
```

Each generated node contains `index.html`, `agent-manifest.json`, `<network>.hocon`,
`<network>.network.json`, `links.json`, `criteria/index.json`, `criteria/<NCT>.json`,
`logistics/<NCT>.json`, `site-actions.js`, `runtime/`, `bridge/`, `.well-known/` and a
`_headers` file that allows any origin to read the JSON files.

### Deployment

- **Deploy only the folders of `dist/deploy/`** (written by `pnpm deploy:check`: the app
  export built with the production config and a copy of each configured `dist/nodes/<area>/`;
  see "Deploy to Cloudflare Pages" below). `pnpm gen` writes the
  DEMO / ADVERSARIAL node to `dist/demo-nodes/` (outside `dist/nodes`, and `pnpm validate`
  fails if it shows up there), and the demo overlay (`configure-nodes.mjs --overlay <dir>`,
  e.g. `/tmp/cs-demo`) is written only where you point it. Neither is ever deployed.
- **The app build refuses localhost nodes** unless the node config says so:
  `config/nodes.dev.json` has `"dev": true` (development) and `config/nodes.demo.json`
  `"demo": true` (and may list only localhost nodes). A deployment config has neither and
  only `https` origins, so a stray `localhost` origin fails the build.
- **One root origin per node.** The runtime loads its sandbox worker from the
  root-absolute path `sandboxWorkerUrl` = `/runtime/sandbox-worker.js`, so each node must
  be served from the root of its own origin, e.g. four subdomains
  (`t2d.example.org`, `breast-cancer.example.org`, …), not from sub-paths of one site.
  Locally, `pnpm serve:nodes` gives each node its own port for the same reason.
- **`_headers` targets Cloudflare Pages** (the format Netlify also reads). It sets
  `Access-Control-Allow-Origin: *` on the JSON files and
  `Content-Security-Policy: default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'`
  on `/runtime/sandbox-worker.js`, the same policy `tools/serve-nodes.mjs` sends. Other
  hosts need the same headers configured their own way.
- **Specialist agents have `"tools": []`.** `criteria_agent` and `logistics_agent` only
  call the page's `website_*` actions. The vendored `build_network.mjs` rejects
  `website_*` names in `tools` (the runtime adds them from `agent-manifest.json`
  `actions.agentTools`), and the vendored template's specialists use `[]` too, so an
  empty list is the conforming value; `build_network.mjs --check` passes on every node.

### Deploy to Cloudflare Pages (free, `*.pages.dev`, no custom domain)

Five Pages projects, each serving one folder from its own origin root:

| Project (assumed name)              | Folder (after `pnpm deploy:check`)              | Origin                                                |
|-------------------------------------|-------------------------------------------------|-------------------------------------------------------|
| `chartstays`                        | `dist/deploy/chartstays`                        | `https://chartstays.pages.dev`                        |
| `chartstays-type-2-diabetes`        | `dist/deploy/chartstays-type-2-diabetes`        | `https://chartstays-type-2-diabetes.pages.dev`        |
| `chartstays-breast-cancer`          | `dist/deploy/chartstays-breast-cancer`          | `https://chartstays-breast-cancer.pages.dev`          |
| `chartstays-chronic-kidney-disease` | `dist/deploy/chartstays-chronic-kidney-disease` | `https://chartstays-chronic-kidney-disease.pages.dev` |
| `chartstays-obesity`                | `dist/deploy/chartstays-obesity`                | `https://chartstays-obesity.pages.dev`                |

The names are an assumption: a project named `X` is served at `https://X.pages.dev`, and Pages
names are global, so if one is taken pick another and change the matching origin (`"app"` or
the node's `"origin"`) in `apps/patient/config/nodes.prod.example.json` (or a copy passed as
`CHARTSTAYS_NODES_CONFIG`). The app's CSP and directory are built from those origins, so the
config must be final before the build. Wrangler runs through `npx`; nothing is added to the repo.

1. Create a free Cloudflare account (dash.cloudflare.com) and verify its email.
2. `npx wrangler login` (opens the browser; `npx wrangler whoami` shows the account).
3. Create the five projects, once:
   ```sh
   for p in chartstays chartstays-type-2-diabetes chartstays-breast-cancer chartstays-chronic-kidney-disease chartstays-obesity; do
     npx wrangler pages project create "$p" --production-branch main
   done
   ```
4. If a name was taken, set the names/origins in the config (above).
5. `pnpm install && pnpm deploy:check` (or `CHARTSTAYS_NODES_CONFIG=<file> pnpm deploy:check`).
   It builds everything with the production config, assembles `dist/deploy/<project>/`, checks
   it (no `/spike`, no "demo node" label or localhost origin in the app, no demo/test node,
   `_headers` in every folder, node JSON readable from the app origin, sandbox worker locked
   down, CSP/directory/manifest equal to the config) and prints the deploy commands. It then
   restores the development node files; run `pnpm -r build` again before `pnpm e2e`.
   `pnpm deploy:check --no-build` re-checks an existing `dist/deploy`.
6. Deploy each folder (the commands `deploy:check` prints, with absolute paths). Wrangler 4.164
   redirects `pages` commands to Workers and fails when run at the root of this pnpm workspace,
   so run it from a neutral directory outside the repo, with `--force` (deploy to Pages without
   the redirect) and `--commit-dirty=true` (the repo has no git metadata):
   ```sh
   R="$PWD"; mkdir -p /tmp/cs-wr && cd /tmp/cs-wr
   for p in chartstays chartstays-type-2-diabetes chartstays-breast-cancer chartstays-chronic-kidney-disease chartstays-obesity; do
     npx wrangler@latest pages deploy "$R/dist/deploy/$p" --project-name "$p" --branch main --commit-dirty=true --force
   done
   ```
7. Test in a fresh browser profile (checklist below).

After the deploy:

- [ ] `curl -sI https://chartstays.pages.dev/match` shows `Content-Security-Policy` (the four
      node origins in `connect-src`), `Referrer-Policy: no-referrer` and `nosniff`.
- [ ] `curl -sI https://chartstays-obesity.pages.dev/criteria/index.json` (each node) shows
      `Access-Control-Allow-Origin: *` (once) and `Referrer-Policy: no-referrer`;
      `/runtime/sandbox-worker.js` has `connect-src 'none'`.
- [ ] `https://chartstays.pages.dev/spike` is a 404.
- [ ] Load a demo patient, open `/match`: no node request before consent (DevTools Network);
      the consent dialog names the four nodes, without "(demo node)" or localhost.
- [ ] Allow all: each node loads its studies; deny one node: 0 requests to it.
- [ ] Trust panel: "Patient data sent: 0 fields".
- [ ] DevTools console: 0 CSP violations on `/` and `/match` (also while using the assistant).
- [ ] Local model (WebGPU browser): the model download from huggingface.co (and its
      `*.aws.cdn.hf.co` CDN) runs under the production `/webllm/*` CSP and the model answers;
      without WebGPU the fallback message appears.

The node sites' own HTML pages still carry the "Demo node, not a real trial site" banner. What
the app and its assistant read from a node (`agent-manifest.json` brand, network `site_name`,
`criteria/index.json` disclaimer) uses neutral names such as "ChartStays · Type 2 diabetes
trials" and says "Demonstration site, not a real trial site"; `deploy:check` fails if a
non-HTML node file says "demo node".

## Commands

Requires Node 22.18+ (TypeScript runs through Node's type stripping) and pnpm 11.

| Command | What it does |
| --- | --- |
| `pnpm install` | Install workspace dependencies |
| `pnpm -r build` | Type-check / build every package, build the patient app |
| `pnpm fetch:ctgov` | Re-download the snapshots for the studies in `data/curation/*.json` (network) |
| `node tools/node-generator/src/cli/fetch.ts --discover <area>` | List recruiting candidates for an area |
| `node tools/node-generator/src/cli/curate.ts` | Rebuild `data/curated/` from snapshots + curation maps |
| `node tools/node-generator/src/cli/curate.ts --print-lines <NCT>` | Show a study's numbered eligibility lines |
| `pnpm gen` | Generate `dist/nodes/<area>/` (offline, from `data/`) |
| `pnpm validate` | `build_network.mjs --check` per node, schema check of all criteria, Synthea code check, stale-curation check (`data/curated` must equal a fresh curate run), and no demo node in the default directory, no TEST-ONLY interop fixture (`"test": true`, `fixture_*`, ports 4106-4111) in any node config or `public/directory.json`; non-zero exit on any failure |
| `pnpm test` | Unit tests (node:test), including the matcher golden matrix, profile privacy and no-network checks |
| `pnpm synthea:timeshift` | Write `data/synthea/shifted/`: the Synthea subset with all dates moved per patient so the latest record date is 2026-11-01 (originals unchanged) |
| `pnpm match:report` | Evaluate every date-shifted Synthea subset patient against every curated study; write `docs/match-matrix.md` and `data/demo-patients.json` (offline) |
| `UPDATE_GOLDEN=1 pnpm --filter @chartstays/matcher test` | Refresh `packages/matcher/test/__golden__/matrix.json` after a reviewed change |
| `pnpm serve:nodes` | Serve the nodes on `http://localhost:4101`-`4104` with CORS (`--log <file>` writes one JSON line per request; `--demo` adds the DEMO / ADVERSARIAL node on 4105) |
| `pnpm serve:app` | Serve `apps/patient/out` on `http://localhost:4000` (127.0.0.1) with its `_headers` applied (CSP on), one log line per request; `--overlay <dir>` serves a `configure-nodes.mjs --overlay` folder over it; Ctrl+C stops it |
| `pnpm e2e` | Headless Chrome end-to-end test of the patient app against the four nodes (needs `pnpm -r build && pnpm gen`; see "Patient app") |

Typical loop: `pnpm gen && pnpm validate && pnpm serve:nodes`.

## Disease areas

| Area | Network | Port | Studies |
| --- | --- | --- | --- |
| Type 2 diabetes | `t2d_trials` | 4101 | 5 |
| Breast cancer | `breast_cancer_trials` | 4102 | 5 |
| Chronic kidney disease | `ckd_trials` | 4103 | 5 |
| Obesity | `obesity_trials` | 4104 | 5 |

The first plan named long COVID and a rare disease. Both were replaced because the
Synthea sample cannot represent them, so no synthetic patient could ever match:

- **Long COVID → chronic kidney disease.** The sample has acute COVID-19
  (SNOMED 840539006) but no post-COVID / long COVID condition code. CKD stages, diabetic
  kidney disease and eGFR (LOINC 33914-3) are present.
- **Rare disease → obesity.** No rare-disease condition appears in the 112-patient sample.
  Obesity BMI codes and BMI observations (LOINC 39156-5) are present in most patients.

## Curation

> Criteria curated by the project team, not reviewed by clinicians; pre-screening only.
> Every criteria document repeats this in `source.modified`.

Studies were picked from RECRUITING interventional studies (`--discover`). For each one,
`data/curation/<area>.json` maps eligibility lines to structured criteria of kind `age`,
`sex`, `condition` (SNOMED CT), `lab` (LOINC) or `medication` (RxNorm), using only codes
found in the Synthea sample (`data/synthea/code-inventory.json`; `pnpm validate` enforces
this). Anything that cannot be coded faithfully stays in `free_text` and a matcher must
report it as unknown. Each map entry carries a `match` string, so a changed record fails
loudly instead of being mapped to the wrong line. Notable conventions:

- eGFR uses Synthea's MDRD code 33914-3; criteria from CKD-EPI or unnamed formulas carry a note.
- Type 1 diabetes, pregnancy, NYHA class, time-bound events, ULN-relative labs and blood
  pressure stay free text (not coded in the sample, or no single numeric observation).
- Medications are limited to RxNorm products present in the sample. The sample has one
  insulin (106892) and one metformin (860975, ER 500 mg) product, so a drug-class
  criterion mapped to them always keeps its free text. `curate` refuses a medication
  criterion with a single product unless `keep_free_text` is set.
- "Malignancy" codes only clearly malignant conditions; neoplasm of prostate (may be
  benign) and carcinoma in situ are left to the free text.
- Text that is garbled in the record is interpreted, noted as such and kept as free text.
- Lines covered by the automatic age criterion (`covered_by: "inc-0a"`) must state its
  age limits; `curate` checks the numbers.
- Numbered criteria the record ran into one paragraph ("…; 5. Serum ferritin…") are split
  into separate lines.
- `eligibility.criteria_text` keeps the ClinicalTrials.gov text exactly as published.

### Matching semantics

A matcher combines the structured criteria of a study like this:

- **Default:** every inclusion criterion must be met; if any exclusion criterion is met,
  the patient is excluded. A criterion whose data is missing is unknown, as is every
  `free_text` entry; unknown never counts as met or not met.
- **Logic groups:** criteria from one source line can share `group` (the line id, e.g.
  `exc-20`) and `group_logic` (both or neither). With `"any"`, one met member is enough:
  an inclusion group is met, an exclusion group excludes. With `"all"`, every member must
  be met. Members of a group share one type and one `group_logic`, and a group has at
  least two members (`validateCriteria` checks this). Example: CKD study NCT06923709
  exc-20 "plasma potassium > 4.9" is coded as serum/plasma (2823-3) **or** blood
  (6298-4) potassium. In a curation map, `"group_logic"` on an entry puts its criteria in
  one group.
- Without a group, criteria from one line are separate: e.g. "HbA1c ≥ 7% and < 10%" is two
  inclusions that must both be met.

## Patient profile and matcher

Both packages are pure TypeScript compiled without Node or DOM types, so they cannot call
`fetch`, `XMLHttpRequest`, `WebSocket` or `navigator.sendBeacon`; a test greps their sources
as well. Matching is deterministic; an LLM may later explain results but never decides them.

**`@chartstays/fhir-profile`** — `parseBundle(bundle, { asOf })` / `parseBundleText(text, { asOf })`:

- Accepts one FHIR R4 `Bundle` with exactly one `Patient`; rejects non-JSON, non-Bundle,
  DSTU2/STU3/R5 markers, and files over 20 MB (`FhirImportError` with a `code`).
- Keeps: `age` on `asOf` (full birth date only, else null), `sex`, conditions (one per
  system + code, `active` on `asOf`, earliest onset), the latest result per LOINC code
  (components such as blood pressure included; coded results as text) and active
  medication requests (RxNorm, `medicationReference` resolved inside the bundle). Data dated
  after `asOf`, entered-in-error and refuted entries are skipped. Conditions marked
  unconfirmed, provisional or differential are kept with `unconfirmed: true` and never
  count as active. `deceased` is set when the record says so (the app shows a warning).
- Never keeps: name, address, telecom, identifiers, resource ids, exact birth date, `text`
  narratives, `note`, `CodeableConcept.text` (display comes from the coding, else the
  code), or any `valueString` (Synthea's PRAPARE questionnaire stores the street address there).

**`@chartstays/matcher`** — `evaluateStudy(profile, criteria, { labMaxAgeDays })` and
`rankStudies(profile, criteriaList)`. Each criterion gets `met`, `not_met` or `unknown`,
the evidence used (code, value, unit, date) and a one-sentence English reason.

| Kind | Rule |
| --- | --- |
| age | inclusive `min`/`max`; unknown without age |
| sex | female/male; unknown when the record says other/unknown |
| condition | met by an active SNOMED match (the most recent onset is reported); a resolved match counts only when the criterion **label** says "history of", "prior" or "previous" and does not negate it ("no prior …"); an unconfirmed match is unknown. No match in the record: **not met** for an inclusion marked `primary: true` (the area's main condition), **unknown** for any other inclusion, **not met** for an exclusion with the reason "No recorded exclusion applies (based on the imported record; absence is not confirmed)" |
| lab | latest result for the LOINC code; unknown when missing, not numeric, older than `labMaxAgeDays` (default 365) before `asOf`, or in a unit the matcher does not know or cannot convert (only analyte-independent conversions such as g/L↔g/dL, mg/mmol↔mg/g; plain mL/min is not eGFR per 1.73 m²); `between` is inclusive |
| medication | met by an active prescription with a listed RxNorm code; otherwise unknown for an inclusion, not met (absence not confirmed) for an exclusion |
| free_text | always unknown; never decides the tier |

Tiers (groups combine as in "Matching semantics" above; an `any` group is met by one met
member, unknown if none is met but one is unknown):

- **not_eligible**: a coded inclusion (or inclusion group) is not met, or a coded exclusion (group) is met.
- **possible_match**: nothing blocks, but at least one coded criterion or group is unknown
  (missing, stale or unconvertible data).
- **strong_match**: every coded inclusion is met and no coded exclusion is met; only
  free-text criteria remain, shown as "N items to confirm with your doctor".

`rankStudies` orders strong_match, possible_match, not_eligible, then fewer coded unknowns,
then fewer free-text items, then NCT id. `docs/match-matrix.md` lists the counts and causes.

### Demo data: date-shifted Synthea records

The report, golden test and demo patients use `data/synthea/shifted/`, written by
`pnpm synthea:timeshift` from `data/synthea/patients/` (left unchanged). These are synthetic
records, dates shifted so the latest encounter is recent; standard practice for synthetic
demo data. Each patient gets one fixed day offset applied to every date (birth date
included), so intervals and age at the latest record are kept and the latest record date is
2026-11-01. The subset has no Encounter resources, so "latest encounter" is the latest
Condition, Observation or MedicationRequest date.

### Patient app

`apps/patient` (static export) imports a FHIR R4 JSON file or a bundled synthetic demo
patient (`public/demo-patients/`, copied from `data/demo-patients.json` at build time),
parses it in the browser, shows a short profile and stores only the profile in IndexedDB.
A stored profile that does not match the current schema is ignored; a profile older than
30 days shows a re-import warning. "Delete my data" deletes the whole IndexedDB database
(if another tab holds it open, the page says deletion is pending until that tab closes) and
clears this origin's localStorage, sessionStorage and script-visible cookies, which removes
the agent runtime's BYOK keys and profiles without changing the vendored runtime, and deletes
the downloaded local model (Cache Storage). The runtime
spike moved to `/spike`, a development page (`app/spike/page.dev.tsx`): it is a route only
under `next dev` or with `CHARTSTAYS_DEV_PAGES=1`, never in `pnpm -r build` or a deployment.

#### Matching across trial nodes (`/match`)

The record stays in the browser; the trial nodes come to it. Flow:

1. `listNodes` reads `public/directory.json` (name, origin, area, network per node).
2. For each node, a consent dialog (modal, keyboard accessible) shows the origin, the
   network name and the purpose "Load public trial criteria; no health data is sent", with
   **Allow once**, **Allow for this session** and **Deny**. Nothing is ever allowed by
   default; a denied node gets no request and the results say "Access to <origin> denied".
   Every decision goes to the in-page trust log (`window.__chartstays.trustLog()`).
3. `loadNode(origin)` fetches the node's `agent-manifest.json`, `criteria/index.json` and
   each criteria file with plain `GET` (`credentials: "omit"`, no referrer, redirects
   rejected, no custom headers). The
   network name must equal the directory entry exactly, every criteria file must pass the
   schema and stay on the node's origin. Fail closed: 10 s timeout, size caps (manifest
   64 KB, index and criteria 256 KB each), at most 50 studies per node and 8 nodes; an
   error on one node never stops the others.
4. `evaluateCriteria` runs `rankStudies` locally (no network); `buildDoctorSheet` writes a
   plain-text summary for the doctor locally. The table shows a verdict badge, title, node, criteria
   met / unknown / not met with expandable reasons, "N items to confirm with your doctor"
   and a ClinicalTrials.gov link.

**Find trials for me** runs these steps deterministically. **Ask the assistant** boots the
vendored runtime with the `patient_navigator` network (`navigator` front agent with
`profile_agent`, `scout_agent`, `matcher_agent`, `advisor_agent`, `inquiry_agent`), which calls the same five
site actions, plus `prepareInquiry` (below), (`public/site-actions.js` is a thin adapter over `lib/site-actions.ts`).
`readProfile` returns only an allow-list summary: the 5-year age band, sex, and the
diagnoses, labs (with month) and medications whose codes the loaded criteria refer to
(nothing else before a node is loaded). The runtime's consent hook is replaced by
ChartStays' gate: only the exact node origins and network names from the directory, never
"always", questions of at most 140 characters shown in full in the dialog, and a question
that mentions a profile value (age, sex words, condition names, synonyms and abbreviations
such as T2D or CKD, lab names and values with rounding) is declined. Every question is
logged, also after "Allow for this session", which can be revoked per node. Agents see node
text (titles, reasons) wrapped in `<<node_text>>` markers as untrusted data, at most 10
results plus totals per verdict, and verdicts only from the deterministic matcher. Before the
runtime boots, the page's `fetch` is wrapped for node origins (`GET` only, no credentials or
referrer, redirects refused, size cap, timeout) and peer manifests lose their `actions`
block, so a node's action bridge is never opened. Links in the assistant's answers open only
to ClinicalTrials.gov, the nodes and this site; any other link is blocked and shown in full.
Without a key the runtime uses its in-browser mock router (`browser://mock`); no key or
router setting is sent to a node.

**Security headers.** `pnpm build` ends with `configure-nodes.mjs --headers`, which writes
`out/_headers` (Cloudflare Pages): `Referrer-Policy: no-referrer`, `nosniff`, a minimal
`Permissions-Policy`, and per page a CSP with `default-src 'self'`, `script-src 'self'` plus
the hashes of Next's inline scripts (no `unsafe-eval`; the criteria validator is compiled
ahead of time by `packages/criteria-schema/scripts/precompile.mjs`), `connect-src` limited to
the configured nodes and the LLM routers, `worker-src 'self' blob:`, `frame-src 'none'` and
`frame-ancestors 'none'`. `style-src` allows inline styles because the runtime injects them.
The local model's worker files (`/webllm/*`) get their own CSP (see "Local model" below).

**Node base URLs** come from build config, not code. `apps/patient/config/nodes.dev.json`
lists the local nodes (`http://localhost:4101`-`4104`). The deployment config is
`apps/patient/config/nodes.prod.example.json` (`"production": true`, an `"app"` origin and
`https://chartstays-<area>.pages.dev` nodes; see "Deploy to Cloudflare Pages"), built by
`pnpm deploy:check`. A config marked `"production": true` fails on any http or localhost
origin, any demo or test node, a node name saying "demo node", or a missing `"app"`, and
`CHARTSTAYS_PRODUCTION=1` (set by `deploy:check`) refuses any config not marked production.

Without `CHARTSTAYS_NODES_CONFIG` the build does not fail: it uses `config/nodes.dev.json`
(marked `"dev": true`) and prints a warning (localhost nodes only work on the build machine).
A config with a localhost origin and neither `"dev": true` nor `"demo": true` fails, and so
does a `"demo": true` config with a non-localhost origin. A node marked `"test": true` (the
interop fixtures of `pnpm e2e`) is only accepted in a config marked `"test": true`, which may list
only localhost nodes.
`scripts/configure-nodes.mjs` (run in `prebuild`) writes `public/directory.json`, the
manifest's `allowed_peers` and `agent/patient_navigator.hocon` from
`agent/patient_navigator.hocon.tmpl`; `--check` (used by `pnpm validate` and
`check:network`) fails when they are stale; `--headers` writes `out/_headers` (above).

**End-to-end test** (headless Chrome over the DevTools protocol, no extra dependency):

```sh
pnpm -r build && pnpm gen
pnpm e2e        # CHROME_PATH=<binary> to use another Chrome
```

It serves `apps/patient/out` on `http://localhost:4000` and the nodes on 4101-4104 (with a
request log), and checks: no node request before consent; allow all → 20 studies for the
hero demo patient with the verdicts of `docs/match-matrix.md`; deny the breast cancer node →
0 requests to it, the other three still load; no profile value, `Authorization` or `Cookie`
in any node request; the agent path with the mock router calls every site action. With the
generated `out/_headers` served it also checks: no CSP violation on any page, a link outside
the allow-list is blocked, a peer network cannot call `website_readProfile`, and a node's
cross-origin redirect is refused. Week 6 checks: an open doctor sheet follows a node loaded
after it was built and links only to ClinicalTrials.gov; the inquiry dialog starts without
health data, an opted-in field appears in its preview, and it makes no request; the local
model option is shown, the no-WebGPU fallback appears (`navigator.gpu` removed), and the
worker runs under its own CSP without downloading anything. A last phase serves the same export with the demo node
config (below) and the nodes on 4101-4105 and checks the Agent Firewall: a question with
health data for the shady node is blocked before anything is sent (and the manual scanner
highlights it without logging); after consent the shady node's injection is neutralized and
the node quarantined, its exfil link is blocked, the trust panel shows the decisions and
"Patient data sent: 0 fields", the four real nodes keep their verdicts and no CSP violation
occurs. A spec §6 interop phase (`s6 *` checks, see `docs/interop-s6.md`) serves TEST-ONLY
fixture nodes on 4106-4111 and a request-logging fake BYOK router on `127.0.0.1:11434`, and checks:
an exact-name mismatch, an invalid network, a composition cycle, the third-party and agent budgets
and an origin outside the directory each fail with a visible message in `#agent-problems`; a
node's `llm_router` is ignored; with a BYOK key the model calls go only to the visitor's router and
no node request carries the key. It stops every server and Chrome it started.

#### Agent Firewall, trust panel and PHI scanner

Everything between the page and a trial node goes through one rule table,
`apps/patient/lib/firewall-rules.ts`, applied by `lib/firewall.ts` on the existing paths
(node loader, the page's peer `fetch` guard, the runtime consent gate, site actions). Rules
only block, neutralize or quarantine; verdicts come only from the matcher.

| Rule | Direction | Action | What it catches |
| --- | --- | --- | --- |
| `out.phi` | outbound | block | a request URL or question containing health data from the record, also disguised (fails closed when the scan cannot run); for URLs the query, fragment and any path other than a node's published files, never the host |
| `out.length` | outbound | block | a question to a node's assistant over 140 characters |
| `out.charset` | outbound | block | a question with anything but printable ASCII (zero-width, look-alike, control characters) |
| `out.long-token` | outbound | block | a question with a run of more than 40 characters without a space |
| `out.quota` | outbound | block | more than 5 questions to one node's assistant per page session (also after "allow for session") |
| `out.method` | outbound | block | anything but `GET` to a node |
| `fw.quarantined` | outbound | block | any request to a quarantined node |
| `in.injection` | inbound | quarantine | "ignore previous instructions", "you are now", fake system tags |
| `in.tool-hijack` | inbound | quarantine | node text naming this page's tools (`readProfile`, …) |
| `in.data-request` | inbound | quarantine | node text asking for patient data or identifiers |
| `in.exfil-url` | inbound | quarantine | a link off ClinicalTrials.gov/the node with a query, fragment or `{placeholder}` |
| `in.foreign-url` | inbound | neutralize | other links off ClinicalTrials.gov/the node (removed) |
| `in.oversize-field` | inbound | neutralize | a text field longer than any real one (clipped) |
| `in.unexpected-field` | inbound | neutralize | fields a node document does not normally have (dropped: manifest, criteria index and `links.json` are projected to their known keys) |
| `in.structure` | inbound | quarantine | a document nested 8+ levels deep, with a list over 200 items or over 2000 text fields (too large to inspect fully, never passed on) |
| `in.excess-fields` | inbound | quarantine | a node asking for more patient fields than its criteria need |
| `in.bridge` | inbound | quarantine | an action bridge/module off the node, tools shadowing this page's, an MCP endpoint |
| `in.oversize-response` | inbound | block | a response over its size cap |
| `in.redirect` | inbound | block | a redirected response |

Patterns and the health-data scan run on the text and on a normalized form (NFKC, invisible
and bidi characters removed, accents and Cyrillic/Greek look-alikes mapped to Latin,
percent-decoding, `_`/`-` as spaces, number words as digits, spelled-out letters joined);
highlights still point at the original text. A negation only excuses a data request when
it directly precedes the verb ("do not send …", not "Without delay, send …"). Every
response from a node's origin goes through the firewall before the app or the runtime uses
it (the loader keeps only the firewall's copy and re-validates criteria; the peer fetch
guard accepts only JSON and also inspects `links.json` and any other file), and peer
manifests lose `actions` and every router, BYOK, model, key, MCP and tool-bundle setting.
The doctor sheet quotes node text through the same neutralizer.
A quarantined node is not contacted again in the page session and its studies are never
matched. Every decision goes to the trust log with rule id, origin, reason and a censored
snippet; blocked outbound text is stored only with each detected value replaced by its kind
(`[condition]`, `[age]`, …). The **Trust panel** on `/match` shows per origin the consent
status (with **Revoke**), each request (URL with its query censored, query length, size,
result), what left the browser (patient fields: 0), the firewall decisions with reasons and
times, a summary line "Patient data sent: 0 fields · Requests: N · Blocked: M" and a JSON
export built from the log (scanner-checked: detected values are replaced by their kind).
**Delete my data** also empties the trust log in memory (`window.__chartstays` reads it);
quarantines stay for the page session. The consent dialog and the panel highlight detected
health data with its kind as text (not colour alone) and a Clean/Blocked status announced
through one persistent `aria-live` region; **Scan text** checks
any text against the record locally and logs nothing. Unit tests:
`apps/patient/test/firewall.test.mjs` (each rule positive and negative, zero findings on the
four published nodes, quarantine of the shady node, redaction).

**DEMO / ADVERSARIAL node.** `pnpm gen` also writes `dist/demo-nodes/shady-demo/` (port 4105,
network `shady_demo_trials`, fake `NCT999999xx` studies), labelled DEMO / ADVERSARIAL on its
page and in its manifest. It is spec-valid but hostile: prompt injection, an exfiltration
link with `{diagnosis}`/`{age}` placeholders, a `_redirects` rule sending a criteria file
off-site, an oversize criteria file, extra requested fields, and sample questions asking for
the diagnosis and age. `pnpm validate` runs the same `build_network --check` and schema checks
on it as on the real nodes (it passes by design: its attacks are in the content, which only
the Agent Firewall judges), skips it in the area/curation checks, and fails when
`config/nodes.dev.json` or `public/directory.json` lists it or any node marked `demo`. It is
loaded only through `apps/patient/config/nodes.demo.json` (`"demo": true` at the top, the
node marked `"demo": true`); `configure-nodes.mjs` refuses a demo node in any other config.
To try it locally without touching the tracked build files:

```sh
pnpm serve:nodes --demo       # nodes on 4101-4105
CHARTSTAYS_NODES_CONFIG=config/nodes.demo.json node apps/patient/scripts/configure-nodes.mjs --overlay /tmp/cs-demo
# serve /tmp/cs-demo in front of apps/patient/out (pnpm e2e does exactly this)
```

#### Local model, inquiry draft and doctor sheet

**Local model (WebLLM).** Under **Ask the assistant**, *Local (WebLLM, free, runs on your
GPU)* runs a small model in this tab instead of the demo router or a BYOK key.
`@mlc-ai/web-llm` is pinned at `0.2.88`; `scripts/vendor-webllm.mjs` (in `prebuild`) copies
its bundle to `public/webllm/web-llm.js`, which only the worker `public/webllm/worker.js`
loads. Models: `Qwen3-1.7B-q4f16_1-MLC` (default, 986 MB download, about 2 GB GPU
memory) and `Qwen3-4B-q4f16_1-MLC` (2.3 GB, 3.4 GB). The panel checks WebGPU (and
says so, with the demo/BYOK fallback, when there is none), shows the size, asks before
downloading (also when only part of the model is cached: **Resume download**), shows
progress with **Cancel download** and has **Delete downloaded model files** (disabled while
the assistant is running on the local model); **Delete my data** deletes the model cache
(Cache Storage and WebLLM's IndexedDB databases) too.

*Tool calls with a small model.* The worker asks WebLLM for grammar-constrained JSON
(`response_format` with a JSON Schema): each reply is `{"tool_calls": [...]}` with exact tool
names and arguments, or `{"final": "..."}`. `lib/webllm-adapter.ts` offers each agent only the
`website_*` actions its HOCON instructions tell it to call (`prepareInquiry`, the irreversible
one, only with an explicit "call", and only alone, once per reply). A request about trials, a
sheet or an inquiry must start with a tool call; a greeting may be answered directly. After
"first call A, then call B", B's `nct_id` is limited to strong or possible matches from A's
parsed result. An answer cut off by the token limit ends with "…(answer cut off — see the
results list on this page)". *Debug log:* in devtools run
`localStorage.setItem("chartstays_debug_llm", "1")` and reload; a banner says it is on, and the
prompts and raw replies go to the console after the health-data redaction (nothing without an
imported record; never to the trust log or the network). There is no URL switch.

*Pinned model files.* `public/webllm/pins.json` (committed, generated by `pnpm -F
@chartstays/patient pin-webllm` = `scripts/pin-webllm.mjs` from the Hugging Face model API
and the GitHub commits API, nothing typed in by hand) pins:

| File | Pinned to |
| --- | --- |
| `mlc-ai/Qwen3-1.7B-q4f16_1-MLC` | HF commit `80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc` (30 shards) |
| `mlc-ai/Qwen3-4B-q4f16_1-MLC` | HF commit `a5c9fab855e3ccbdfed2e7e69683d75f30332161` (74 shards) |
| `Qwen3-{1.7B,4B}-q4f16_1_cs1k-webgpu.wasm` | `mlc-ai/binary-mlc-llm-libs` commit `146ed9cd4b4062e967b017fd2291f7106b50599f` (`web-llm-models/v0_2_87/base/`) |

Weights are fetched from `https://huggingface.co/<repo>/resolve/<commit>/`. The worker
downloads `tensor-cache.json` and every shard itself, checks each against the sha256 in
`pins.json` (shards: the LFS sha256 from the HF tree API) and only then puts it in WebLLM's
cache; WebLLM then checks `mlc-chat-config.json`, `tokenizer.json` and the WebGPU library
against their pinned SRI hashes (`ModelRecord.integrity`, `onFailure: "error"`). Shards
already in the cache were verified when stored and are trusted on later loads if their size
matches; `tensor-cache.json` is re-checked on every load. The WebGPU libraries are served
from this site: `scripts/fetch-webllm-libs.mjs` (part of `vendor-webllm`, in `prebuild`)
downloads them into `public/webllm/libs/` (gitignored), fails the build on a sha256
mismatch and only warns when offline (the local model then cannot start until they are
fetched). The runtime is booted with the pseudo-router `browser://webllm`,
which the page's fetch guard answers in the page (`lib/webllm-adapter.ts`): Chat Completions
with tools become a Qwen prompt, `<tool_call>` JSON in the reply is parsed strictly
(unknown tool, bad JSON or arguments that fail the tool's schema reject the whole reply; one
repair attempt), and the answer is streamed back as OpenAI SSE. Only the model files are
downloaded; the pages' CSP is unchanged and the worker gets its own `_headers` rule:
`/webllm/*` → `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'
https://huggingface.co https://*.aws.cdn.hf.co; worker-src 'none'`. Large (LFS) files
redirect from huggingface.co to the Xet CDN (measured: `us.aws.cdn.hf.co`, path
`/xet-bridge-us/…`); the region is part of the host name and chosen by Hugging Face, hence
`*.aws.cdn.hf.co` rather than one host. The adapter and the worker protocol are unit-tested
with fakes; `pnpm e2e` watches the worker's own requests over CDP (auto-attach to the worker
target) with every Hugging Face request blocked, so a real model download and run are not
part of the automated tests.

##### Try the local model in your own Chrome

Needs a Chrome with WebGPU (desktop Chrome 113+) and about 1 GB free for the default model.

```sh
pnpm -r build && pnpm gen   # out/ with _headers, the WebGPU libraries, dist/nodes
pnpm serve:nodes            # terminal 1: nodes on 4101-4104
pnpm serve:app              # terminal 2: the app on http://localhost:4000, CSP on
```

1. Open `http://localhost:4000/`, choose a demo patient (e.g. `demo-type-2-diabetes`) and
   click **Load demo patient** (or import your own FHIR bundle).
2. Open `http://localhost:4000/match`. Under **Ask the assistant**, pick *Local (WebLLM, free,
   runs on your GPU)*, choose the model and click **Download …**, then confirm. Progress shows
   the verified download, then WebLLM's loading; **Cancel download** stops it (verified files
   stay cached, a new download resumes).
3. When the model is loaded the assistant starts on it; ask e.g. "Find trials for me" and
   answer its consent dialogs for the nodes.

Worker logs: the model runs in the dedicated worker `/webllm/worker.js`. Open DevTools on the
`/match` tab and pick the worker under **Sources > Threads** (its console then shows the
worker's messages and errors), or open `chrome://inspect/#workers` and click **inspect** next to
`http://localhost:4000/webllm/worker.js`. Its **Network** panel lists the Hugging Face and
`/webllm/` requests; a CSP block or an integrity failure shows up there and in the panel's
error text. **Delete downloaded model files** (or **Delete my data**) removes the model again.
Stop both servers with Ctrl+C.

**prepareInquiry** (sixth site action, `effect: "irreversible"`, input `nct_id` of a strong
or possible match). Each such result row also has **Prepare inquiry**. ChartStays' own dialog
(the runtime's confirmation hook is replaced and locked, and accepts one `prepareInquiry` of
this site for a current match only) shows a draft that by default holds only the study id,
its ClinicalTrials.gov link and a generic question; the study title, the pre-screening result
and the record items the study's `requested_fields_for_inquiry` asks for are each opt-in. The
full text is shown with the PHI scanner's highlights before **Prepare this text**; the result
can only be copied or downloaded, nothing is sent, and the study team is contacted through
its ClinicalTrials.gov page. The agent gets back status, field names and counts, never the
text; the trust log records field names and counts only.

**Doctor sheet.** **Show doctor sheet** on `/match` (and the agent's `buildDoctorSheet`)
renders a printable summary: the minimal profile, each strong/possible study with the reason
per coded criterion (met / not met / unknown), the free-text criteria for the doctor, the
ClinicalTrials.gov link and snapshot date, the nodes not included and a disclaimer. Every
build, print and download evaluates again over all loaded nodes, and an open sheet rebuilds
when a node is loaded. Node text goes through the firewall's neutralizer and is rendered as
text; the only links are `https://clinicaltrials.gov/study/NCT…` pages. `@media print`
prints only the sheet. Unit tests: `apps/patient/test/webllm-adapter.test.mjs`,
`apps/patient/test/inquiry-sheet.test.mjs`.

## Data attribution and licenses

- **ClinicalTrials.gov**: study records from [ClinicalTrials.gov](https://clinicaltrials.gov/),
  a service of the U.S. National Library of Medicine, via API v2 (version 2.0.5),
  retrieved 2026-11-16. ChartStays selected fields, shortened summaries and structured the
  eligibility criteria; every document's `source` block says what changed and links the
  authoritative record. Contact names, emails and phone numbers are not republished; nodes
  link to the record instead. Listing does not imply endorsement by NLM or the sponsors.
- **Synthea**: synthetic patients generated by Synthea (Apache License 2.0); see
  `data/synthea/README.md` for the exact sample, commit and checksum.
- **agentic-web runtime**: Apache License 2.0, vendored unchanged; see
  `vendor/agentic-web/VENDOR.md`.
- ChartStays code: Apache License 2.0.
