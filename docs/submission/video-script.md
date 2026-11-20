# Demo video script (English, under 2 minutes)

Read aloud in your own voice (rules: narration by the entrant, not AI-generated; see `../../../docs/stage1-conformance.md` §2.6).
Narration: **200 words** (limit 260), about 1:20 at 150 wpm, leaving room for pauses. Target length 1:45.

| Time | On screen (page and action) | Narration |
| --- | --- | --- |
| 0:00-0:12 | Landing `/`, hero "Your record stays. The trials come to you." | Checking whether you qualify for a clinical trial usually means handing over your medical record first. ChartStays turns that around: the trials come to your record. |
| 0:12-0:22 | Click **Try with a demo patient** (TryDemoButton): loads the synthetic type 2 diabetes patient, opens `/match`. Show the short profile. | One click loads a synthetic demo patient with type 2 diabetes. The record is stored in this browser only. |
| 0:22-0:35 | `/match`: press **Find trials for me**. Consent dialog appears per site; click **Allow once** four times. | I press Find trials. Each trial site asks for my consent before anything loads. I allow all four. |
| 0:35-0:55 | Results table: verdict badges, expand "Why" on one study. Scroll to the Trust panel: "Patient data sent: 0 fields". | Matching runs on my device: strong match, possible match, or criteria not met, with a reason for every criterion. The Trust panel counts what was sent to the sites: zero fields of patient data. |
| 0:55-1:07 | **Local recording** with the demo overlay (shady node on :4105, not deployed). Allow the shady site; show Trust panel firewall decision "quarantined" and its studies absent. | Now a hostile demo site. Its text contains a prompt injection. The Agent Firewall quarantines it, and its studies are left out. |
| 1:07-1:30 | "Ask the assistant" with **Local (WebLLM)** selected, model already cached. Ask "Prepare an inquiry for the best match" (about 18 s real, **cut/speed up**). Show the inquiry dialog: only study id ticked, fields unticked. Then ask for the doctor sheet (about 92 s real, **cut/speed up**) and show the sheet. Put "sped up" on screen. | The assistant runs a small model locally on my GPU, so my questions stay on this device. It is slow, so this part is sped up. I ask it to prepare an inquiry: the dialog starts with no health data, and I choose each field. Then it builds a sheet for my doctor. |
| 1:30-1:45 | Back to Trust panel or landing "Privacy you can check"; show the disclaimer line. | Every site publishes its own agent network over plain HTTPS, and my browser loads it after consent. Agents travel; the record stays. This is pre-screening, not medical advice. |

## Where to cut waiting time
- Local model first load (about 1 GB download): do it before recording; never show it.
- Strong-match answer about 35 s, inquiry about 18 s, doctor sheet about 92 s (measured WebLLM times, task brief). Cut or speed up; keep the "sped up" label on screen so it is honest.
- The shady segment needs the demo config (`pnpm serve:nodes --demo` + overlay, README "DEMO / ADVERSARIAL node"). Say nothing implying it is deployed; the on-screen label "DEMO / ADVERSARIAL" is enough.

## Recording notes
- 1920x1080, browser zoom 110-125%, hide bookmarks bar, one Chrome window with WebGPU.
- Model must be cached before recording (Chrome profile with the Qwen3-1.7B files); test once.
- Do NOT click **Delete my data** (it also deletes the cached model and the trust log).
- Use a fresh page load for the take so the Trust panel counters start at a clean state.
- Optional if time (stage 1 check 5): BYOK is not in this 2-minute cut; link `interop-s6.md` in the description instead.

## Sources of facts
Landing copy `apps/patient/app/page.tsx`; flow, Trust panel, firewall, local model, inquiry dialog, doctor sheet: `README.md` (sections "Matching across trial nodes", "Agent Firewall...", "Local model, inquiry draft and doctor sheet"); timings and Local scope: task brief; spec checks: `docs/interop-s6.md`. Button label verified in `try-demo-button.tsx:34`.
