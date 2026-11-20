# Screenshot list for the Devpost gallery

Existing files are in `/Users/yhoyoex/Project/Devpost/preview/chartstays-7b/` (local dev build, localhost nodes). Their content was NOT re-inspected here; check each by eye. Devpost gallery should preferably show the deployed site, so retake after deploy.

| # | Page and state | Caption (max 15 words) | Existing file | Retake after deploy |
| --- | --- | --- | --- | --- |
| 1 | Landing hero (`/`) | Your record stays in the browser. The trials come to you. | `v3-landing-hero-mobile.png` (mobile only); desktop: `v2-landing-hero-desktop.png` | Yes, v3 desktop |
| 2 | `/match` step 3, demo patient loaded, consent dialog open | Each trial site asks for consent before anything is loaded. | `v3-match-step3-desktop.png` (unchecked if dialog is shown) | Yes, take with dialog open |
| 3 | `/match` results, "Why" expanded | Verdicts with a reason for every criterion, computed on your device. | `v2-match-results-desktop.png` | Yes |
| 4 | Trust panel, "Patient data sent: 0 fields" | A counted zero: every request to trial sites is logged and scanned. | `v2-match-trust-desktop.png` | Yes |
| 5 | Shady demo node quarantined (Trust panel firewall decisions) | The Agent Firewall quarantines a site that tries prompt injection. | none | Local demo overlay only |
| 6 | Assistant with Local (WebLLM) selected | Optional local model: questions stay on your device. | `v3-match-agent-desktop.png` | Yes, after model loaded |
| 7 | Inquiry dialog, default (no health data ticked) | Sharing is opt-in, field by field. | none | Yes |
| 8 | Doctor sheet | A printable sheet to discuss with your doctor. | none | Yes |

Also usable: `v3-match-step4-desktop.png` (step 4 view).
