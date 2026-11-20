# Devpost description (draft)

Links: Demo `https://chartstays.pages.dev` · Video `https://youtu.be/-W-GVHxsNDM` · Code `https://github.com/Akar-Samudra-Artifisial/chartstays`

## Inspiration
Checking whether you qualify for a clinical trial usually means handing your medical record to a matching service or study site before you know whether you qualify. We wanted to turn that around: bring the criteria to the record. (Landing copy, `apps/patient/app/page.tsx`.)

## What it does
ChartStays pre-screens a patient for clinical trials inside the browser. The patient imports a FHIR R4 record or picks a synthetic demo patient (Synthea); it is stored in the browser only and can be deleted. Four demo trial sites (type 2 diabetes, breast cancer, chronic kidney disease, obesity), each on its own origin, publish their eligibility criteria and an agent network. After the patient allows a site, the criteria are loaded and a local matcher gives each study a verdict: Strong match, Possible match or Criteria not met, with a reason per criterion. Requests to trial sites carry no record data; the Trust panel shows "Patient data sent: 0 fields". An assistant can answer questions, draft an inquiry (starts with no health data, opt-in per field, copy or download only, nothing is sent) and build a doctor sheet. (`README.md` "Matching across trial nodes", "prepareInquiry", "Doctor sheet".)

## How we built it
- Monorepo: a Next.js static patient app, a FHIR-to-profile package, a deterministic matcher (no network, no LLM), and a generator that turns ClinicalTrials.gov records into static trial-node sites with `agent-manifest.json`, network JSON and `links.json`.
- The vendored agentic-web runtime (unchanged) runs the `patient_navigator` network in the browser.
- Agent Firewall: one rule table checks everything between the page and a node (prompt injection, data-grabbing links, oversize or unexpected fields), plus a health-data scanner on outbound text.
- Assistant models: demo (mock) router, bring-your-own-key router, or a local WebLLM model (Qwen3-1.7B, about 986 MB download once).
- Hosting: static sites on Cloudflare Pages (`*.pages.dev`), free.

## Challenges
- Small local models are slow: in our runs a strong-match answer took about 35 s, an inquiry about 18 s and a doctor sheet about 92 s, so the video is sped up in those parts. (Task brief measurements.)
- Eligibility text is messy. Criteria were curated by the team, not reviewed by clinicians; what cannot be coded stays free text and is shown as "to confirm with your doctor". (`README.md` "Curation".)
- The synthetic sample could not represent long COVID or a rare disease, so we replaced them with CKD and obesity. (`README.md` "Disease areas".)
- Hardening the page-to-node boundary (consent, redirects, size caps, firewall).

## Accomplishments
- Zero patient fields sent to trial sites, counted and exportable.
- Automated check suite: `pnpm -r build && pnpm gen && pnpm test && pnpm validate && pnpm e2e` exited 0 with 44 PASS, 0 FAIL on 2026-11-17 (`docs/interop-s6.md`).
- Hostile-site demo: the Agent Firewall quarantines a prompt-injecting node while the four real nodes keep working.

## What we learned
- The deterministic part must decide; the LLM only explains.
- Real-world trial criteria are rarely fully codable, so "unknown" is a first-class result.
- Showing an auditable count beats a privacy promise.

## What's next
Not built yet: real trial-site onboarding, more areas, clinician review of criteria, EHR integration. Out of scope for this entry: enrollment, accounts, backend. (`docs/product-brief.md` §9.)

## Limitations
Pre-screening only, not medical advice; the doctor and study team decide. Trial sites are demos and cannot enroll anyone. Patient data is synthetic. Privacy claim is scoped: trial sites never receive your record; only the Local model keeps your assistant questions on the device, while a BYOK router receives your questions.

## How it meets the challenge
Mapping to the spec section 6 interoperability checks; details, code references and test names in `chartstays/docs/interop-s6.md`.

| # | Check | How |
| --- | --- | --- |
| 1 | Publish network and manifest over HTTPS | Each trial site is a static site with manifest, network JSON, `links.json`, CORS |
| 2 | Browser run, default router, BYOK | Mock router by default; BYOK path in the runtime's AI model settings |
| 3 | Internal agents and a site action | `patient_navigator` delegates to agents and calls site actions |
| 4 | Exact network from a second origin after consent | Consent gate and exact-name match; mismatch fails visibly |
| 5 | Key not sent to second site | Peer fetches omit credentials; peer manifest router settings ignored |
| 6 | Private context only if allowed | Profile stays in page; firewall; opt-in inquiry fields |
| 7 | Visible errors | `#agent-problems` panel: invalid network, cycle, budget, refused origin |

## Built with
TypeScript, Next.js (static export), agentic-web runtime (Apache 2.0), WebLLM (Qwen3), FHIR R4, Synthea, ClinicalTrials.gov API v2, Cloudflare Pages, pnpm.

Data: ClinicalTrials.gov records (NLM; listing does not imply endorsement); Synthea synthetic patients. (`README.md` "Data attribution".)
