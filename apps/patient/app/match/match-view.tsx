"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toConfirmText, type CriterionResult, type CriterionStatus, type Verdict } from "@chartstays/matcher";
import type { DirectoryEntry } from "../../lib/directory";
import type { MatchRow, MatchRun, NodeState } from "../../lib/trial-session";
import { loadProfile } from "../profile-store";
import AgentPanel from "./agent-panel";
import { ctgovUrlFor, studyOf } from "../../lib/inquiry";
import DemoSteps from "../demo-steps";
import { CriteriaBar, Hint, Icon, SectionHead, type IconName } from "../icons";
import ConsentDialog from "./consent-dialog";
import DoctorSheet from "./doctor-sheet";
import InquiryDialog from "./inquiry-dialog";
import { getMatchApp, type MatchApp } from "./match-app";
import TrustPanel from "./trust-panel";

const VERDICT_LABEL: Record<Verdict, string> = {
  strong_match: "Strong match",
  possible_match: "Possible match",
  not_eligible: "Criteria not met",
};

const INCLUSION_LABEL: Record<CriterionStatus, string> = { met: "Met (inclusion)", unknown: "Unknown (inclusion)", not_met: "Not met (inclusion)" };
// An exclusion the matcher marks not_met only means none is recorded; absence is not confirmed (matcher ABSENT_EXCLUSION).
const EXCLUSION_LABEL: Record<CriterionStatus, string> = { met: "Exclusion applies", unknown: "Unknown (exclusion)", not_met: "No recorded exclusion applies" };

function criterionLabel(c: Pick<CriterionResult, "status" | "type">): string {
  return (c.type === "exclusion" ? EXCLUSION_LABEL : INCLUSION_LABEL)[c.status];
}

/**
 * How a criterion counts for the patient, based on the imported record: a met exclusion counts against;
 * one with no recorded match "fits" (not confirmed absent). Display only.
 */
type Fit = "fit" | "confirm" | "against";

function fitOf(c: Pick<CriterionResult, "status" | "type">): Fit {
  if (c.status === "unknown") return "confirm";
  const met = c.status === "met";
  return (c.type === "exclusion" ? !met : met) ? "fit" : "against";
}

const FIT_ICON: Record<Fit, IconName> = { fit: "check-circle", confirm: "help-circle", against: "x-circle" };

/** Counted the way the matcher decides: a group of alternatives ("A or B") counts once, with the group's status. */
function fitCounts(row: Pick<MatchRow, "criteria" | "groups">): Record<Fit, number> {
  const counts: Record<Fit, number> = { fit: 0, confirm: 0, against: 0 };
  for (const c of row.criteria) if (c.group === undefined) counts[fitOf(c)] += 1;
  for (const g of row.groups) counts[fitOf(g)] += 1;
  return counts;
}

function nodeStatusText(state: NodeState): string {
  switch (state.status) {
    case "idle":
      return "Not contacted";
    case "loading":
      return "Loading public criteria…";
    case "loaded":
      return `${state.studies} studies loaded${state.rejected.length ? `, ${state.rejected.length} rejected` : ""}`;
    case "denied":
      return state.message;
    case "error":
      return `Could not load: ${state.message}`;
    case "quarantined":
      return `QUARANTINED: ${state.message}`;
  }
}

function useSession(app: MatchApp | null): number {
  // A counter that changes on every session event, so the view re-reads session state.
  const [version, setVersion] = useState(0);
  useEffect(() => (app === null ? undefined : app.session.subscribe(() => setVersion((v) => v + 1))), [app]);
  return version;
}

export default function MatchView() {
  const [app, setApp] = useState<MatchApp | null>(null);
  const [nodes, setNodes] = useState<DirectoryEntry[]>([]);
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [assistantStarted, setAssistantStarted] = useState(false);
  const [showNotMet, setShowNotMet] = useState(false);
  useSession(app);
  const [, setConsentVersion] = useState(0);
  useEffect(() => (app === null ? undefined : app.consent.subscribe(() => setConsentVersion((v) => v + 1))), [app]);

  useEffect(() => {
    const instance = getMatchApp();
    setApp(instance);
    instance
      .directory()
      .then(setNodes)
      .catch((e: unknown) => setError(`Could not read the list of trial sites: ${e instanceof Error ? e.message : String(e)}`));
    loadProfile()
      .then((p) => setHasProfile(p !== null))
      .catch(() => setHasProfile(false));
  }, []);

  async function onFind(): Promise<void> {
    if (app === null) return;
    setBusy(true);
    setError("");
    setStatus("Asking before contacting each trial site…");
    try {
      reportRun(await app.session.findAll(), (await app.directory()).length);
    } catch (e) {
      setStatus("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function reportRun(result: MatchRun, total: number): void {
    if (total > 0 && result.missing.length >= total) {
      setStatus("");
      setError("No trial site could be loaded, so nothing was matched. See the reasons under Step 3 and try again.");
      return;
    }
    setStatus(`Matched ${result.rows.length} studies in this browser.`);
  }

  async function onRetry(origin: string): Promise<void> {
    if (app === null) return;
    setBusy(true);
    setError("");
    setStatus(`Asking before contacting ${origin} again…`);
    try {
      await app.session.loadNode(origin, "find");
      reportRun(await app.session.evaluate(), (await app.directory()).length);
    } catch (e) {
      setStatus("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const run = app?.session.lastRun() ?? null;
  const sessionAllowed = new Set(app?.consent.sessionOrigins() ?? []);

  // Unknown until the saved record has been checked: no step is marked, so the indicator does not flicker.
  const step = hasProfile === null ? undefined : hasProfile === false ? 1 : run === null ? 2 : assistantStarted ? 4 : 3;
  const notMet = run?.rows.filter((r) => r.verdict === "not_eligible").length ?? 0;
  const strong = run?.rows.filter((r) => r.verdict === "strong_match").length ?? 0;
  const possible = run?.rows.filter((r) => r.verdict === "possible_match").length ?? 0;
  const siteCount = new Set(run?.rows.map((r) => r.node.origin) ?? []).size;
  // Studies with criteria not met are folded away behind a button, unless they are all there is.
  const canFold = run !== null && notMet > 0 && notMet < run.rows.length;
  const folded = canFold && !showNotMet;

  // Wide screens: steps and results on the left, the Trust panel beside them (CSS grid only; DOM order
  // stays main column first, so keyboard and screen-reader order is unchanged).
  return (
    <div className="match-layout">
      <div className="match-main">
      <DemoSteps current={step} />
      <p className="disclaimer" role="note">
        <Icon name="alert" />
        <span>
          <strong>Pre-screening, not medical advice.</strong> Results show which public criteria your record fits. Your doctor and the study team decide
          whether you are eligible.
        </span>
      </p>

      {hasProfile === null ? (
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" />
          Checking for your record in this browser…
        </p>
      ) : null}
      {hasProfile === false ? (
        <div className="card empty-state" role="status">
          <span className="section-icon">
            <Icon name="user" />
          </span>
          <div>
            <p>
              <strong>No health record in this browser yet.</strong> Load a synthetic demo patient first; it takes one click.
            </p>
            <a className="button-link" href="/#get-started">
              Choose a demo patient
            </a>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="find-heading" className="card">
        <SectionHead icon="building" step={2} id="find-heading" title="Allow trial sites">
          Press the button and you will be asked before each trial site is contacted. Allowing a site lets it send its public criteria to this page; the
          request to it carries no data from your record. Denying one does not stop the others.
        </SectionHead>
        <Hint term="What is a trial site?">
          A website run for one research area (for example type 2 diabetes trials) that publishes the eligibility criteria of its studies and an agent
          that can answer questions. In this demo the sites are separate local or demo servers.
        </Hint>
        <div className="find-row">
          <button type="button" id="find-trials" onClick={() => void onFind()} disabled={busy || app === null || hasProfile !== true}>
            {busy ? <span className="spinner spinner-on-accent" aria-hidden="true" /> : <Icon name="search" />}
            Find trials for me
          </button>
          <p aria-live="polite" className="status" id="find-status">
            {status}
          </p>
        </div>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}

        <h3 id="nodes-heading" className="subhead">
          Trial sites
        </h3>
        <ul aria-labelledby="nodes-heading" className="nodes" id="node-list">
          {nodes.map((n) => {
            const state = app?.session.state(n.origin) ?? { status: "idle" as const };
            return (
              <li key={n.origin} data-origin={n.origin} data-status={state.status} className="node-item">
                <span className="node-icon">
                  <Icon name="building" />
                </span>
                <span className="node-main">
                  <strong>{n.name}</strong> <span className="muted node-origin">{n.origin}</span>
                  <span className="visually-hidden">:</span>
                </span>
                <span className="node-status">
                  <span className={`status-pill status-${state.status}`}>{nodeStatusText(state)}</span>
                  {sessionAllowed.has(n.origin) ? (
                    <>
                      {" "}
                      <span className="muted">(allowed for this session)</span>{" "}
                      <button type="button" className="secondary small revoke" data-origin={n.origin} onClick={() => app?.consent.revoke(n.origin, n.network)}>
                        Revoke
                      </button>
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
          {nodes.length === 0 && error === "" ? (
            <li className="node-item node-loading">
              <span className="spinner" aria-hidden="true" /> Loading the list of trial sites…
            </li>
          ) : null}
        </ul>
      </section>

      {run === null ? (
        <section aria-labelledby="results-placeholder-heading" className="card" id="results-area">
          <SectionHead icon="filter" step={3} id="results-placeholder-heading" title="See matches" />
          {busy ? (
            <div className="results-loading" role="status">
              <p className="muted loading-line">
                <span className="spinner" aria-hidden="true" />
                Matching starts as soon as you answer the questions about each trial site…
              </p>
              <ul className="skeleton-list" aria-hidden="true">
                <li className="skeleton" />
                <li className="skeleton" />
                <li className="skeleton" />
              </ul>
            </div>
          ) : (
            <EmptyResults>Your results appear here after the trial sites send their criteria.</EmptyResults>
          )}
        </section>
      ) : null}

      {run !== null ? (
        <section aria-labelledby="results-heading" className="card" id="results-area">
          <SectionHead icon="filter" step={3} id="results-heading" title="See matches" />
          <div className="results-summary" id="results-summary">
            <p className="summary-line">
              <span className="summary-chip chip-strong">
                <strong>{strong}</strong> strong
              </span>
              <span className="summary-sep" aria-hidden="true">
                ·
              </span>
              <span className="summary-chip chip-possible">
                <strong>{possible}</strong> possible
              </span>
              <span className="summary-sep" aria-hidden="true">
                ·
              </span>
              <span className="summary-chip chip-notmet">
                <strong>{notMet}</strong> criteria not met
              </span>
              <span className="summary-across">
                across {siteCount} trial {siteCount === 1 ? "site" : "sites"}
              </span>
            </p>
            <ul className="verdict-legend verdict-legend-inline" aria-label="What the results mean">
              <li>
                <span className="verdict verdict-strong_match">Strong match</span> every coded criterion fits, based on your record
              </li>
              <li>
                <span className="verdict verdict-possible_match">Possible match</span> some criteria unknown from the record
              </li>
              <li>
                <span className="verdict verdict-not_eligible">Criteria not met</span> a coded criterion does not fit
              </li>
            </ul>
            <Hint term="How are criteria counted?">
              Each study lists inclusion and exclusion criteria. &quot;Fit&quot; means it fits, based on your record: an inclusion criterion is met, or no
              recorded exclusion applies (a condition missing from the record is not proof you do not have it). &quot;To confirm&quot; means the record
              cannot answer it (free text or missing data). &quot;Don&apos;t fit&quot; means your record does not meet this study&apos;s criteria.
            </Hint>
          </div>
          {run.missing.length > 0 ? (
            <ul className="missing" id="missing-nodes" aria-label="Trial sites not included">
              {run.missing.map((m) => (
                <li key={m.origin} className="warning" data-origin={m.origin} data-status={m.status}>
                  <Icon name="alert" />
                  <span>
                    <strong>{m.name}</strong> was not included:{" "}
                    <span className={m.status === "denied" ? "denied" : m.status === "error" ? "load-error" : m.status === "quarantined" ? "quarantined" : "not-loaded"}>
                      {m.status === "error" ? `could not load (${m.message})` : m.message}
                    </span>{" "}
                    {m.status !== "quarantined" ? (
                      <button type="button" className="secondary small retry" data-origin={m.origin} disabled={busy} onClick={() => void onRetry(m.origin)}>
                        Try again
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {run.rejected.length > 0 ? (
            <details id="rejected-studies" className="disclosure">
              <summary>
                {run.rejected.length} {run.rejected.length === 1 ? "study was" : "studies were"} skipped because the site's data failed checks
              </summary>
              <ul>
                {run.rejected.map((r, i) => (
                  <li key={`${r.origin}-${r.nct_id ?? i}`} data-origin={r.origin}>
                    {r.name}: {r.nct_id ?? "unknown study"}: {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {run.rows.length === 0 ? (
            <EmptyResults>No studies were matched. Allow at least one trial site, then try again.</EmptyResults>
          ) : null}
          <div className="results-region" role="region" aria-label="Matched studies" tabIndex={0}>
            {/* Explicit table roles: CSS lays each row out as a card (display: grid). */}
            <table id="results" role="table" data-folded={folded ? "true" : "false"}>
              <caption className="muted">
                {run.rows.length} studies, matched in this browser on {run.asOf}. Strong matches first.
                {folded ? ` ${notMet} with criteria not met are folded away below.` : ""}
              </caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Result
                  </th>
                  <th scope="col" role="columnheader">
                    Study
                  </th>
                  <th scope="col" role="columnheader">
                    Trial site
                  </th>
                  <th scope="col" role="columnheader">
                    Criteria
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {run.rows.map((row) => (
                  <ResultRow key={row.nct_id} row={row} onInquiry={() => void app?.desk.request(studyOf(row), "user")} />
                ))}
              </tbody>
            </table>
          </div>
          {canFold ? (
            <button type="button" className="secondary show-not-met" aria-controls="results" aria-expanded={showNotMet} onClick={() => setShowNotMet((v) => !v)}>
              {showNotMet ? `Hide the ${notMet} studies with criteria not met` : `Show ${notMet} more (criteria not met)`}
            </button>
          ) : null}
        </section>
      ) : null}

      {app !== null ? <DoctorSheet app={app} /> : null}
      {app !== null ? <AgentPanel app={app} onStart={() => setAssistantStarted(true)} /> : null}
      </div>
      <div className="match-side">{app !== null ? <TrustPanel app={app} /> : null}</div>
      {app !== null ? <ConsentDialog consent={app.consent} /> : null}
      {app !== null ? <InquiryDialog app={app} /> : null}
    </div>
  );
}

function EmptyResults({ children }: { children: ReactNode }) {
  return (
    <div className="empty-results">
      <span className="empty-icon">
        <Icon name="search" />
      </span>
      <p className="muted">{children}</p>
    </div>
  );
}

function recruitmentText(value: string): string {
  const v = value.replace(/_/g, " ").toLowerCase();
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function ResultRow({ row, onInquiry }: { row: MatchRow; onInquiry: () => void }) {
  const counts = fitCounts(row);
  // Built from the validated NCT id, never from a URL in the site's data.
  const ctgovUrl = ctgovUrlFor(row.nct_id);
  return (
    <tr role="row" data-nct={row.nct_id} data-verdict={row.verdict} className={`result-card${row.verdict === "not_eligible" ? " row-not-met" : ""}`}>
      <td role="cell" className="cell-verdict">
        <span className={`verdict verdict-${row.verdict}`}>{VERDICT_LABEL[row.verdict]}</span>
      </td>
      <td role="cell" className="cell-study">
        <span className="study-title">{row.title}</span>
        <span className="study-meta">
          {ctgovUrl !== null ? (
            <a href={ctgovUrl} rel="noreferrer noopener" target="_blank">
              {row.nct_id} on ClinicalTrials.gov<span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          ) : (
            <span>{row.nct_id}</span>
          )}
          {row.recruitment ? <span className="meta-chip">{recruitmentText(row.recruitment)}</span> : null}
        </span>
        {row.unknowns.free_text > 0 ? <span className="study-confirm muted">{toConfirmText(row.unknowns.free_text)}</span> : null}
        <details className="why">
          <summary>Why: {row.reasons[0] ?? "see criteria"}</summary>
          <ul className="reasons">
            {row.criteria.map((c) => {
              const fit = fitOf(c);
              return (
                <li key={c.id} data-status={c.status} className={`reason reason-${fit}`}>
                  <Icon name={FIT_ICON[fit]} />
                  <span>
                    <strong>{criterionLabel(c)}</strong>: {c.label}
                    <span className="reason-detail muted">{c.reason}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
        {row.verdict !== "not_eligible" ? (
          <button type="button" className="secondary small prepare-inquiry" data-nct={row.nct_id} onClick={onInquiry}>
            <Icon name="send" />
            Prepare inquiry<span className="visually-hidden"> for {row.nct_id}</span>
          </button>
        ) : null}
      </td>
      <td role="cell" className="cell-site">
        <Icon name="building" />
        <span>
          <span className="cell-label">Trial site: </span>
          {row.node.name}
          <span className="muted site-origin">{row.node.origin}</span>
        </span>
      </td>
      <td role="cell" className="cell-criteria">
        <span className="crit-text">
          <span className="crit-n crit-n-fit">{counts.fit} fit</span>
          <span aria-hidden="true"> · </span>
          <span className="crit-n crit-n-confirm">{counts.confirm} to confirm</span>
          <span aria-hidden="true"> · </span>
          <span className="crit-n crit-n-against">{counts.against} don&apos;t fit</span>
        </span>
        <CriteriaBar fit={counts.fit} confirm={counts.confirm} against={counts.against} />
      </td>
    </tr>
  );
}
