# YouTube upload: ChartStays demo video

Files (outside this repo): `Video Content/chartstays-demo/export/`
- `chartstays-demo.mp4` (1920×1080, 30 fps, H.264 + AAC, 74.3 s)
- `chartstays-demo.en.srt` / `.en.vtt` (English captions, upload as "English" subtitles)
- `chartstays-thumbnail.png` / `.jpg` (1280×720)

Sources for every claim: `devpost-description.md`, `video-script.md`.

## Title

Recommended:

> ChartStays: Clinical Trial Pre-Screening Where Your Record Stays

Alternatives:

- Trials Come to Your Record: Private, In-Browser Trial Matching
- ChartStays Demo: On-Device Trial Matching, 0 Patient Fields Sent

## Description

```
Checking whether you qualify for a clinical trial usually means handing over your medical record first. ChartStays turns that around: the trials come to your record.

ChartStays pre-screens a patient for clinical trials inside the browser. You import a FHIR R4 record or pick a synthetic demo patient; it is stored in this browser only and can be deleted.

How privacy works:
• Each trial site publishes its own eligibility criteria and agent network over plain HTTPS.
• Your browser loads a site only after you give consent, per site.
• Matching runs on your device: Strong match, Possible match or Criteria not met, with a reason for every criterion. The Trust panel counts what was sent to the sites: 0 fields of patient data.
• The Agent Firewall quarantines a hostile site whose text contains a prompt injection.
• The assistant can run a small model locally with WebLLM, so your questions stay on the device. It drafts an inquiry that starts with no health data, and a sheet for your doctor.

Try it: https://chartstays.pages.dev
Code: https://github.com/Akar-Samudra-Artifisial/chartstays

Chapters
0:00 The problem and a demo patient
0:17 Consent and on-device matching
0:35 Agent Firewall and local assistant
0:59 How the network works

Disclaimer: pre-screening only, not medical advice; your doctor and the study team decide. Patients are synthetic (Synthea). Trial sites are demos and cannot enroll anyone. Narration uses an AI clone of the entrant's own voice. Slow local-model parts are sped up.

Built for the Open Agentic Web Challenge.

#ClinicalTrials #HealthPrivacy #AgenticWeb
```

## Tags

```
ChartStays, clinical trials, clinical trial matching, trial pre-screening, patient privacy, health data privacy, privacy by design, on-device AI, local LLM, WebLLM, in-browser AI, AI agents, agentic web, Open Agentic Web Challenge, prompt injection, agent firewall, FHIR, Synthea, ClinicalTrials.gov, Next.js, healthcare AI, hackathon demo
```

## Hashtags

`#ClinicalTrials #HealthPrivacy #AgenticWeb` (already the last line of the description; YouTube shows the first three above the title).

## Upload settings

| Setting | Value |
| --- | --- |
| Visibility | Public (judges must be able to open it) |
| Audience | No, it's not made for kids |
| Category | Science & Technology |
| Video language / caption language | English / English (upload `chartstays-demo.en.srt`) |
| Altered or synthetic content | **Yes**: the narration is a realistic AI-generated clone of the entrant's voice (YouTube requires disclosure of realistic synthetic voice) |
| Paid promotion | No |
| Thumbnail | `chartstays-thumbnail.png` (fallback `.jpg`) |
| Comments | On (optional) |
| License | Standard YouTube License |

Note: Devpost rules in `video-script.md` ask for the entrant's own narration; the AI voice clone is disclosed in the description and the altered-content setting.
