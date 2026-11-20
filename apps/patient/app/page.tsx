import DemoSteps from "./demo-steps";
import { CriteriaBar, Icon, type IconName } from "./icons";
import ImportView from "./import-view";
import TryDemoButton from "./try-demo-button";

const HOW_IT_WORKS: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    icon: "lock",
    title: "Your record stays here",
    body: "Import a FHIR health record, or pick a synthetic demo patient. It is read and stored in this browser only: no account, no upload, delete it any time.",
  },
  {
    icon: "building",
    title: "Trial sites come to you",
    body: "Each trial site publishes its eligibility criteria and an agent on its own website. You choose which sites may be contacted; they send public criteria to this page.",
  },
  {
    icon: "cpu",
    title: "Matching runs on your device",
    body: "Code in this page checks age, diagnoses, lab results and medications against every study and explains each result. An assistant answers questions and drafts an inquiry or a sheet for your doctor.",
  },
];

const GUARANTEES: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    icon: "eye",
    title: "A counted zero, not a promise",
    body: "The Trust panel logs every request this page makes to a trial site and scans it for values from your record. \"Patient data sent\" is that count, in requests to trial sites; you can export the log.",
  },
  {
    icon: "check-circle",
    title: "You allow each site",
    body: "Nothing is contacted until you say so, per site. Deny one and the others still work; revoke a permission at any time.",
  },
  {
    icon: "shield",
    title: "Agent Firewall",
    body: "Text from trial sites is checked for prompt injection and data-grabbing links. A site that tries is quarantined and its studies are left out.",
  },
  {
    icon: "send",
    title: "Sharing is opt-in, field by field",
    body: "An inquiry to a study team starts with no health data. You tick each field to include, see the exact text, and send it yourself.",
  },
];

const STAYS = [
  "Your FHIR record and the profile made from it (age, sex, conditions, labs, medications)",
  "Every match result and the reason for it",
  "Questions to the demo model (a scripted mock) or the local model on your GPU",
];

const LEAVES: ReadonlyArray<{ to: string; what: string }> = [
  {
    to: "Trial sites you allow",
    what: "A plain request for their public criteria, and any question the assistant asks a site's agent. Both are scanned for values from your record before they leave; a hit is blocked.",
  },
  { to: "A study team", what: "An inquiry, only if you prepare one: no health data unless you tick a field, and you send it yourself." },
  { to: "Your AI provider", what: "Your questions to the assistant, only if you add your own provider key instead of the demo or local model." },
];

const VERDICTS = [
  { verdict: "strong_match", label: "Strong match", note: "Every coded criterion fits; only free-text items are left for your doctor." },
  { verdict: "possible_match", label: "Possible match", note: "Nothing rules it out, but some coded criteria are unknown from the record." },
  { verdict: "not_eligible", label: "Criteria not met", note: "At least one coded criterion is not met, with the reason shown." },
] as const;

/** The illustration next to the headline: what a results screen looks like, built in HTML. */
function HeroVisual() {
  const rows = [
    { verdict: "strong_match", label: "Strong match", title: "Lifestyle program for type 2 diabetes", fit: 6, confirm: 3, against: 0 },
    { verdict: "strong_match", label: "Strong match", title: "Once-weekly treatment and weight", fit: 4, confirm: 5, against: 0 },
    { verdict: "possible_match", label: "Possible match", title: "Kidney function and blood pressure", fit: 3, confirm: 7, against: 0 },
  ] as const;
  return (
    <figure className="hero-visual">
      <div className="mock-window" aria-hidden="true">
        <div className="mock-bar">
          <span className="mock-dots">
            <span />
            <span />
            <span />
          </span>
          <span className="mock-pill">
            <Icon name="lock" />
            Matched in your browser
          </span>
        </div>
        <p className="mock-summary">
          <span className="mock-example">Example</span>
          <span>3 of the studies, top matches first</span>
        </p>
        <ul className="mock-rows">
          {rows.map((r) => (
            <li key={r.title} className="mock-row">
              <span className={`verdict verdict-${r.verdict}`}>{r.label}</span>
              <span className="mock-title">{r.title}</span>
              <CriteriaBar fit={r.fit} confirm={r.confirm} against={r.against} />
            </li>
          ))}
        </ul>
        <div className="mock-trust">
          <span className="live-dot" />
          <span>
            <span className="mock-trust-label">Patient data sent</span>
            <strong className="mock-trust-value">0 fields</strong>
          </span>
          <span className="mock-trust-side">in requests to trial sites</span>
        </div>
      </div>
      <figcaption>
        Example of the results screen (illustrative studies, not the demo&apos;s numbers): each study gets a verdict and a criteria summary, and the Trust panel counts what left your browser.
      </figcaption>
    </figure>
  );
}

export default function Page() {
  return (
    <main id="content" className="landing" tabIndex={-1}>
      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="eyebrow">
            <Icon name="shield" />
            Privacy-first clinical trial pre-screening
          </p>
          <h1 id="hero-heading">Your record stays. The trials come to you.</h1>
          <p className="lead">
            ChartStays pre-screens you for clinical trials inside your browser. Trial sites send their criteria to you, and nothing from your record is
            sent to them unless you choose to share it.
          </p>
          <div className="row hero-actions">
            <TryDemoButton />
            <a className="button-link ghost" href="#how-it-works">
              How it works
            </a>
          </div>
          <p className="hero-note">
            <Icon name="clock" />
            <span>One click loads a synthetic patient with type 2 diabetes and opens the trial search. About 2 minutes in total.</span>
          </p>
          <DemoSteps label="Demo steps (summary)" compact className="hero-steps" />
        </div>
        <HeroVisual />
      </section>

      <DemoSteps label="The demo in four steps" className="landing-steps" />

      <section aria-labelledby="problem-heading" className="band problem">
        <h2 id="problem-heading">The problem</h2>
        <div className="problem-grid">
          <p>
            Clinical trials need eligible volunteers, and patients rarely hear about the studies that might fit them. Checking usually means handing your
            medical record to a matching service or study site before you know whether you qualify.
          </p>
          <p className="problem-turn">
            <strong>ChartStays turns that around.</strong> The criteria travel to your record, and the answer stays with you until you choose to share.
          </p>
        </div>
      </section>

      <section aria-labelledby="how-it-works" className="band band-fill">
        <p className="eyebrow">Three steps</p>
        <h2 id="how-it-works" tabIndex={-1}>
          How it works
        </h2>
        <ol className="how-steps">
          {HOW_IT_WORKS.map((s, i) => (
            <li key={s.title} className="feature-card">
              <span className="feature-icon">
                <Icon name={s.icon} />
              </span>
              <h3>
                <span className="feature-num" aria-hidden="true">
                  {i + 1}
                </span>
                {s.title}
              </h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <h3 className="legend-heading">What a result means</h3>
        <ul className="verdict-legend">
          {VERDICTS.map((v) => (
            <li key={v.verdict}>
              <span className={`verdict verdict-${v.verdict}`}>{v.label}</span>
              <span>{v.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="privacy" className="band">
        <p className="eyebrow">Privacy</p>
        <h2 id="privacy" tabIndex={-1}>
          Privacy you can check
        </h2>
        <p className="band-intro">Not a promise in a policy: each of these is visible on the results page while you use it.</p>
        <div className="flow-grid">
          <div className="flow-card flow-stays">
            <h3>
              <Icon name="lock" />
              Stays in this browser
            </h3>
            <ul className="flow-list">
              {STAYS.map((s) => (
                <li key={s}>
                  <Icon name="check" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flow-card flow-leaves">
            <h3>
              <Icon name="send" />
              Leaves only as described
            </h3>
            <ul className="flow-list">
              {LEAVES.map((l) => (
                <li key={l.to}>
                  <Icon name="arrow-right" />
                  <span>
                    <strong>{l.to}:</strong> {l.what}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <dl className="guarantees">
          {GUARANTEES.map((g) => (
            <div key={g.title}>
              <dt>
                <Icon name={g.icon} />
                {g.title}
              </dt>
              <dd>{g.body}</dd>
            </div>
          ))}
        </dl>
        <p className="muted small-text">
          The assistant&apos;s demo model and the local GPU model run in this browser. If you add your own AI provider key, your questions to the assistant
          also go to that provider.
        </p>
      </section>

      <p className="disclaimer" role="note">
        <Icon name="alert" />
        <span>
          <strong>Pre-screening, not medical advice.</strong> ChartStays cannot enroll you in a study and does not tell you what treatment to take. Your
          doctor and the study team decide whether a trial is right for you.
        </span>
      </p>

      <section className="cta-band" aria-labelledby="cta-heading">
        <div>
          <h2 id="cta-heading">See it with a synthetic patient</h2>
          <p>No account, no real data. The demo patient is loaded into this browser and you can delete it at any time.</p>
        </div>
        <div className="row">
          <TryDemoButton id="try-demo-bottom" />
          <a className="button-link secondary" href="#get-started">
            Choose another patient
          </a>
        </div>
      </section>

      <section aria-labelledby="demo-guide-heading" className="get-started" id="get-started">
        <div className="card demo-guide">
          <h2 id="demo-guide-heading" tabIndex={-1}>
            A 2-minute demo
          </h2>
          <ol className="guide-list">
            <li>
              <strong>Choose a patient.</strong> Load a demo patient below (type 2 diabetes is a good first choice), or use the button at the top.
            </li>
            <li>
              <strong>Allow trial sites.</strong> Press <strong>Find trials for me</strong> and answer each site&apos;s request. Try denying one: the others
              still load.
            </li>
            <li>
              <strong>See matches.</strong> Read the results and open &quot;Why&quot; on a study. Prepare an inquiry or the doctor sheet.
            </li>
            <li>
              <strong>Ask the assistant.</strong> Start it with the demo model and ask, for example, &quot;Which trials fit me?&quot;. The local GPU model is
              optional: it downloads about 1 GB once and each answer can take 20 to 90 seconds.
            </li>
          </ol>
          <p className="muted">Then check the Trust panel (beside the results on wide screens, below them on smaller ones): it counts what was sent to each trial site.</p>
        </div>
        <div className="get-started-import">
          <ImportView />
        </div>
      </section>
    </main>
  );
}
