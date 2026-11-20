# Interop checks (spec §6)

How ChartStays meets the seven interoperability checks of the Worldwide Agentic Web MVP spec §6,
which automated check proves each one, and how to show it by hand (for the demo video).

Automated checks are in `tools/e2e/patient-e2e.mjs` (run with `pnpm -r build && pnpm gen && pnpm e2e`).
The §6 phase uses TEST-ONLY fixtures (`tools/e2e/interop-fixtures.mjs`, `"test": true`, loopback
ports 4106-4111) and a fake BYOK router that records every request (`tools/e2e/fake-router.mjs`,
`127.0.0.1:11434`, the only loopback router origin the dev CSP allows). The fixtures are never in
`config/nodes*.json` or `public/directory.json`; `pnpm validate` check 6
(`tools/node-generator/src/test-nodes.ts:27`, called from `tools/node-generator/src/cli/validate.ts:149`)
fails if one leaks there, and `apps/patient/scripts/configure-nodes.mjs:71` refuses a `test` node
outside a config marked `"test": true` (`:81`: such a config may list only localhost nodes).

**Status (2026-11-17):** `pnpm -r build && pnpm gen && pnpm test && pnpm validate && pnpm e2e`
exits 0: 44 PASS, 0 FAIL (the 34 earlier checks plus 10 `s6` checks); the vendored runtime is
identical to `vendor/agentic-web/skills/agentify-website/runtime`. No runtime change was needed.

Errors are shown in the page, not only in the console: the runtime trace is mapped by
`apps/patient/lib/agent-problems.ts:48` (`problemFromTrace`) to the `#agent-problems` panel
(`role="alert"`, `apps/patient/app/match/agent-panel.tsx:185`). Consent refusals by the gate
(`agent-panel.tsx:103-106`) and hand-offs to an origin outside the directory that the firewall
removed (`agent-problems.ts:93` `problemFromFirewall`, `agent-panel.tsx:107`) appear there too.
Each message is redacted with the firewall (`apps/patient/lib/firewall.ts:198` `redactForLog`)
and kept in the trust log; directory origins, hosts and network names are public and kept as is
(`agent-panel.tsx:93`), so e.g. `t2d_trials` is never shown as `[condition]_trials`.

| # | §6 check | How it is met | Proof |
| --- | --- | --- | --- |
| 1 | Publish a two-agent network and manifest over plain HTTPS | Each trial node is a static site: `agent-manifest.json` + `<network>.network.json` + `links.json` with CORS (`tools/node-generator/src/generate.ts:278`); the patient app publishes `apps/patient/public/agent-manifest.json` and `patient_navigator.network.json` | `pnpm validate` (`build_network.mjs --check` per node and for the app); e2e `a every node contacted after consent` |
| 2 | Run in the browser with the default router; BYOK path | Default: the runtime's browser mock (`agent-manifest.json:80`, no key); BYOK: `direct_byok` (`agent-manifest.json:81`) and the runtime's ⚙ AI model settings (router URL, model, key in `sessionStorage`) | e2e `d mock router only`; `s6 2 BYOK: model calls go to the visitor's router with the key` |
| 3 | Call an internal agent and at least one MCP or registered site action | `patient_navigator` delegates to internal agents and calls the site actions of `public/site-actions.js` through the bridge | e2e `d agent calls every site action successfully` |
| 4 | After consent, load the exact network from a second origin and run it locally | Consent gate accepts only the directory's network for that origin (`apps/patient/lib/runtime-consent.ts:44-49`); the runtime refuses any other name (`public/runtime/engine.js:422-425`) | e2e `d node loaded via loadNode`; `s6 4 exact network name: a mismatch fails with a visible message` |
| 5 | With a key active, the second site gets no key and cannot change the router | Runtime sends `Authorization` only to the chosen router (`public/runtime/llm.js:115-127`); peer fetches use `credentials: "omit"`, no referrer (`apps/patient/lib/peer-fetch.ts:103`); the peer manifest loses `llm_router`/key/model keys (`peer-fetch.ts:32-40`) | e2e `s6 5 BYOK key never sent to a node (url, headers, body), no Authorization to nodes`; `s6 5 node manifest's llm_router ignored: the peer runs on the visitor's router`; `c no profile values, Authorization or Cookie in node requests` |
| 6 | Private context is not in the peer unless a named field is allowed | The profile stays in the page; every outbound text passes the Agent Firewall (`apps/patient/lib/firewall.ts:147`); peers cannot call `website_readProfile`; inquiry fields are opt-in (`apps/patient/lib/inquiry.ts:50`) | e2e `c no profile values, ...`; `e peer network cannot call website_readProfile`; `shady b no 4105 request carries profile values`; `w6 prepareInquiry sends no request` |
| 7 | Visible errors for invalid network, cycle, over budget, refused origin | Runtime validation (`engine.js:203-206`), cycle check (`runner.js:449`), budgets (`runner.js:63`, `:76`), origin outside the directory: its link is removed from the node's network JSON by the Agent Firewall before the runtime sees it (`apps/patient/lib/firewall-rules.ts:413` `in.foreign-url`, via `peer-fetch.ts:137`) and any call to it is refused by the consent gate (`runtime-consent.ts:45`); all shown in `#agent-problems` | e2e `s6 7 invalid network refused ...`, `s6 7 composition cycle skipped ...`, `s6 7 third-party budget ...`, `s6 7 agent budget ...`, `s6 7 origin outside the directory refused, gets 0 requests` |

The §6 phase also checks `s6 consent asked for each listed peer before contact; 0 CSP violations`.

## Fixtures (test only)

| Port | Network | Purpose |
| --- | --- | --- |
| 4106 | `fixture_invalid` | An agent without `name` → "Network 'fixture_invalid' (localhost:4106) failed validation: Every agent must have a 'name'."; its front agent also hands off to 4111 |
| 4107 | `fixture_cycle` | Calls itself → composition cycle skipped |
| 4108 | `fixture_budget` | 31 agents → "the per-query limit of 24 agent invocations was reached" |
| 4109 | `fixture_named` | Publishes `fixture_renamed` only → "No published network named 'fixture_named' at localhost:4109; refusing to run a different network." |
| 4110 | `fixture_router` | A valid network whose manifest sets `llm_router` to `/hijack/v1`: it must run on the visitor's router, `/hijack` gets 0 requests |
| 4111 | `fixture_unlisted` | Not in the directory → the link to it is removed ("Refused to contact http://localhost:4111/fixture_unlisted … not a trial node in the directory"), 0 requests |

With the five listed fixtures plus a real node, the runtime's limit of 4 third-party calls per query
is reached in turn 1 → "the per-query limit of 4 third-party calls was reached". Turn 2 asks the
fake router to skip the first four peers with one `skip:<tool>` word each (a single long word is
refused by the firewall rule `out.long-token`, which is correct behaviour), so `fixture_budget`
runs and hits "the per-query limit of 24 agent invocations was reached".

Choices made while running the checks (not weakened assertions):
- The hand-off to 4111 lives in `fixture_invalid`, not in `fixture_router`: the firewall removes
  the foreign link and leaves a dangling tool name, so a network carrying it can never run; the
  router check needs a network that does run.
- The trust log records the boot router as a URL and each model call's router as a host
  (`localhost:11434`); the BYOK check accepts both forms of the same router.

## Manual demo (1-3 clicks each)

Start: `pnpm -r build && pnpm gen`, then `pnpm serve:nodes` and `pnpm serve:app`; open
`http://localhost:4000/match`, load the demo patient.

1. **Publish:** open `http://localhost:4101/agent-manifest.json` and the network JSON it lists.
2. **Default router / BYOK:** click "Start the assistant", ask a question (mock router answers).
   For BYOK: ⚙ AI model settings → enter router URL, model and key → ask again.
3. **Internal agent + site action:** ask "check my trials"; the trust panel lists the site actions called.
4. **Second origin:** the consent dialog shows the node's origin and purpose → Allow; the trace
   shows its network loaded by exact name.
5. **Key stays home:** with BYOK on, open DevTools → Network, filter `localhost:410`: no
   `Authorization`, no key in URL or body; the model calls go only to your router.
6. **Private context:** the trust panel shows "Patient data sent: 0 fields"; opening the inquiry
   dialog shows only the fields you opt in.
7. **Visible errors:** serve the fixtures with a `"test": true` overlay (as `pnpm e2e` does) and
   ask a question: `#agent-problems` lists the invalid network, the cycle, the budget and the
   refused origin with their messages.
