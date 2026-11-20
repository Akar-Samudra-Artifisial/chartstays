"use client";

import { useEffect, useState } from "react";
import { phiSegments, scanText, type PhiScan } from "../../lib/phi-scan";
import { summaryLine, trustReport, type OriginReport } from "../../lib/trust-report";
import { Icon, SectionHead } from "../icons";
import type { MatchApp } from "./match-app";
import { PhiHighlight, ScanStatus } from "./phi-highlight";

function time(at: number): string {
  return new Date(at).toLocaleTimeString();
}

function size(bytes: number | null): string {
  if (bytes === null) return "–";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * What this page did with each trial node: consent, every request, what left the browser and
 * every Agent Firewall decision. Built from the trust log, which holds no patient data.
 */
export default function TrustPanel({ app }: { app: MatchApp }) {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const offs = [app.log.subscribe(bump), app.consent.subscribe(bump), app.firewall.subscribe(bump)];
    return () => offs.forEach((off) => off());
  }, [app]);

  const report = trustReport(app.log.events(), app.firewall.quarantined());
  const sessionAllowed = new Set(app.consent.sessionOrigins());

  function exportJson(): void {
    const blob = new Blob([JSON.stringify(trustReport(app.log.events(), app.firewall.quarantined()), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chartstays-trust-report.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section aria-labelledby="trust-heading" id="trust-panel" className="trust-panel">
      <SectionHead icon="shield" id="trust-heading" title="Trust panel">
        What this page sent to each trial site, counted from its own request log. Patient data sent is the number of values from your record found in
        those requests.
      </SectionHead>
      <div
        id="trust-summary"
        className="trust-summary"
        aria-live="polite"
        data-fields={report.summary.patientFieldsSent}
        data-requests={report.summary.requests}
        data-blocked={report.summary.blocked}
      >
        {/* The same text as summaryLine, one statistic per tile; the separators are kept for screen readers and copy. */}
        {summaryLine(report.summary)
          .split(" · ")
          .map((part, i) => {
            const [label, value] = part.split(": ");
            const tone = i === 0 ? (report.summary.patientFieldsSent === 0 ? "ok" : "alert") : "plain";
            return (
              <span key={label} className={`trust-stat trust-stat-${tone}`}>
                {i > 0 ? <span className="visually-hidden"> · </span> : null}
                <span className="trust-stat-label">
                  {i === 0 ? <span className="live-dot" aria-hidden="true" /> : null}
                  {label}
                  <span className="visually-hidden">: </span>
                </span>
                <span className="trust-stat-value">{value}</span>
              </span>
            );
          })}
      </div>
      <p className="trust-firewall-line">
        <Icon name="shield" />
        <span>
          Agent Firewall: {report.summary.quarantined} {report.summary.quarantined === 1 ? "site" : "sites"} quarantined, {report.summary.neutralized} items
          neutralized. Each request and question this page sends to a trial site is scanned for values from your record before it leaves; &quot;Patient
          data sent&quot; counts those values in requests to trial sites.
        </span>
      </p>
      <div className="trust-toolbar">
        <h3 className="subhead">Trial sites contacted</h3>
        <button type="button" id="trust-export" className="secondary small" onClick={exportJson}>
          <Icon name="download" />
          Export trust report (JSON, scanner-checked)
        </button>
      </div>
      {report.origins.length === 0 ? (
        <div className="empty-results empty-compact">
          <span className="empty-icon">
            <Icon name="building" />
          </span>
          <p className="muted">No trial site has been contacted yet.</p>
        </div>
      ) : null}
      {report.origins.map((o) => (
        <OriginSection key={o.origin} report={o} allowed={sessionAllowed.has(o.origin)} onRevoke={() => app.consent.revoke(o.origin, o.network)} />
      ))}
      <ScanBox app={app} />
    </section>
  );
}

function OriginSection({ report: o, allowed, onRevoke }: { report: OriginReport; allowed: boolean; onRevoke: () => void }) {
  const fields = o.patientFieldsSent;
  return (
    <section className="trust-origin" data-origin={o.origin} data-quarantined={o.quarantined !== null ? "true" : "false"} aria-label={`Trust record for ${o.origin}`}>
      <h3>
        <Icon name="building" />
        <span>
          {o.origin} {o.network ? <span className="muted">({o.network})</span> : null}
        </span>
        <span className={`status-pill ${fields === 0 ? "status-loaded" : "status-error"}`}>
          {fields} patient {fields === 1 ? "field" : "fields"}
        </span>
      </h3>
      {o.quarantined !== null ? (
        <p className="quarantine-note" role="status">
          <strong>QUARANTINED</strong> for this session: {o.quarantined}. Its studies are not used and it is not contacted again.
        </p>
      ) : null}
      <p>
        Consent: <strong className="trust-consent">{allowed ? "allowed for this session" : o.consent}</strong>{" "}
        {allowed ? (
          <button type="button" className="secondary small trust-revoke" data-origin={o.origin} onClick={onRevoke}>
            Revoke
          </button>
        ) : null}
      </p>
      <p className="trust-sent">
        Sent from this browser: <strong>{fields} patient fields</strong>; {o.requests.length} plain GET {o.requests.length === 1 ? "request" : "requests"}
        {o.questions.length > 0 ? `, ${o.questions.length} ${o.questions.length === 1 ? "question" : "questions"} to its assistant` : ""}.
      </p>
      {o.requests.length > 0 ? (
        <details className="disclosure">
          <summary>Requests ({o.requests.length})</summary>
          <div className="table-scroll" role="region" aria-label={`Requests to ${o.origin}`} tabIndex={0}>
          <table className="trust-requests">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">URL</th>
                <th scope="col">Size</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {o.requests.map((r, i) => (
                <tr key={i} data-result={r.result}>
                  <td>{time(r.at)}</td>
                  <td>
                    <code>
                      {o.origin}
                      {r.path}
                      {r.query !== null ? r.query : ""}
                    </code>
                    {r.queryLength > 0 ? <span className="muted"> (query: {r.queryLength} characters)</span> : null}
                  </td>
                  <td>{size(r.bytes)}</td>
                  <td>{r.result === "ok" ? "OK" : `Error: ${r.detail ?? ""}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </details>
      ) : null}
      {o.questions.length > 0 ? (
        <ul className="trust-questions" aria-label="Questions sent">
          {o.questions.map((q, i) => (
            <li key={i}>
              {time(q.at)}: <q>{q.text}</q> <ScanStatus found={q.patientFields} />
            </li>
          ))}
        </ul>
      ) : null}
      {o.firewall.length > 0 || o.blocked.length > 0 ? (
        <div className="table-scroll">
        <table className="trust-firewall" aria-label={`Firewall decisions for ${o.origin}`}>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Decision</th>
              <th scope="col">Rule</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {o.firewall.map((f, i) => (
              <tr key={`f${i}`} className={`fw-${f.action}`} data-rule={f.rule} data-action={f.action}>
                <td>{time(f.at)}</td>
                <td>
                  <strong>{f.action.toUpperCase()}</strong> ({f.direction})
                </td>
                <td>
                  <code>{f.rule}</code>
                </td>
                <td>
                  {f.reason}
                  {f.redacted !== null ? (
                    <div>
                      <PhiHighlight segments={f.redacted} />
                    </div>
                  ) : f.snippet !== null ? (
                    <div className="muted">
                      <code>{f.snippet}</code>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
            {o.blocked.map((b, i) => (
              <tr key={`b${i}`} className="fw-blocked" data-action="blocked">
                <td>{time(b.at)}</td>
                <td>
                  <strong>BLOCKED</strong>
                </td>
                <td>{b.what}</td>
                <td>{b.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}
    </section>
  );
}

/** Scan any text against the imported record, in this browser only; nothing is logged or sent. */
function ScanBox({ app }: { app: MatchApp }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ text: string; scan: PhiScan } | null>(null);
  const [error, setError] = useState("");

  async function scan(): Promise<void> {
    setError("");
    try {
      const terms = await app.terms();
      if (terms === null) {
        setResult(null);
        setError("Import a health record first; the scanner looks for terms from it.");
        return;
      }
      setResult({ text, scan: scanText(text, terms) });
    } catch (e) {
      setResult(null);
      setError(`The scan could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="scan-box">
      <h3 id="scan-heading">
        <Icon name="search" />
        Scan text for health data
      </h3>
      <p className="muted">The same check the firewall applies before anything leaves. Runs in this browser; the text is not saved or sent.</p>
      <label htmlFor="scan-text">Text to scan</label>
      <textarea id="scan-text" rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" id="scan-run" className="secondary small" onClick={() => void scan()}>
        Scan text
      </button>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {/* One live region that stays in the page, so each new result is announced. */}
      <div id="scan-result" role="status" aria-live="polite">
        {result !== null ? (
          <>
            <ScanStatus id="scan-status" found={result.scan.spans.length} />
            <p>
              <PhiHighlight id="scan-highlight" segments={phiSegments(result.text, result.scan.spans)} />
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
