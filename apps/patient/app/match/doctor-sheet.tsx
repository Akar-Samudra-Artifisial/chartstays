"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { doctorSheetText, freshDoctorSheet, type DoctorSheetModel } from "../../lib/doctor-sheet";
import type { CriterionStatus } from "@chartstays/matcher";
import { SectionHead } from "../icons";
import { DATA_DELETED_EVENT, loadProfile } from "../profile-store";
import { DOCTOR_SHEET_EVENT, type MatchApp } from "./match-app";

const STATUS_LABEL: Record<CriterionStatus, string> = { met: "Met", not_met: "Not met", unknown: "Unknown" };
/** Printing shows only this element (globals.css @media print), a copy of the sheet. */
const PRINT_ROOT_ID = "print-root";

/**
 * The printable doctor sheet. Every build, print and download evaluates again over all loaded
 * nodes (freshDoctorSheet), and an open sheet rebuilds when a node is loaded, so it never shows an
 * older run. Node text is rendered as text; the only links are ClinicalTrials.gov study pages.
 * "Delete my data" removes the sheet from the page.
 */
export default function DoctorSheet({ app }: { app: MatchApp }) {
  const [sheet, setSheet] = useState<DoctorSheetModel | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [printRoot, setPrintRoot] = useState<HTMLElement | null>(null);
  const builtAt = useRef<number | null>(null);
  const printNext = useRef(false);

  const latest = useRef(0);

  // The print copy lives in a direct child of <body> while a sheet exists.
  useEffect(() => {
    if (sheet === null) return;
    const root = document.createElement("div");
    root.id = PRINT_ROOT_ID;
    document.body.append(root);
    setPrintRoot(root);
    return () => {
      root.remove();
      setPrintRoot(null);
    };
  }, [sheet === null]);

  useEffect(() => {
    if (sheet !== null) setAnnouncement(`Doctor sheet ready: ${sheet.studies.length} ${sheet.studies.length === 1 ? "study" : "studies"}, prepared ${sheet.generatedAt.slice(11, 16)} UTC.`);
  }, [sheet]);

  useEffect(() => {
    const onDeleted = () => {
      latest.current += 1;
      builtAt.current = null;
      printNext.current = false;
      setSheet(null);
      setError("");
      setAnnouncement("The doctor sheet was removed with your data.");
    };
    window.addEventListener(DATA_DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(DATA_DELETED_EVENT, onDeleted);
  }, []);

  async function build(): Promise<DoctorSheetModel | null> {
    setError("");
    // Builds can overlap (a node moves from loading to loaded); only the newest one is shown.
    const seq = ++latest.current;
    const revision = app.session.revision();
    builtAt.current = revision;
    try {
      const model = await freshDoctorSheet(app.session, loadProfile);
      if (seq !== latest.current) return model;
      setSheet(model);
      return model;
    } catch (e) {
      if (seq === latest.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function run(action: "built" | "printed" | "downloaded"): Promise<void> {
    setBusy(true);
    try {
      const model = await build();
      if (model === null) return;
      app.log.record({ type: "doctor_sheet", action, via: "user", studies: model.studies.length });
      if (action === "printed") printNext.current = true;
      if (action === "downloaded") {
        const url = URL.createObjectURL(new Blob([doctorSheetText(model)], { type: "text/plain;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `doctor-sheet-${model.generatedAt.slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setBusy(false);
    }
  }

  // Print after the fresh sheet is on the page (and in the print root).
  useEffect(() => {
    if (!printNext.current || sheet === null || printRoot === null) return;
    printNext.current = false;
    window.print();
  }, [sheet, printRoot]);

  // An open sheet follows node loads; the agent's buildDoctorSheet opens it.
  useEffect(() => {
    const unsubscribe = app.session.subscribe(() => {
      if (builtAt.current !== null && builtAt.current !== app.session.revision()) void build();
    });
    const onAgent = () => void build();
    app.events.addEventListener(DOCTOR_SHEET_EVENT, onAgent);
    return () => {
      unsubscribe();
      app.events.removeEventListener(DOCTOR_SHEET_EVENT, onAgent);
    };
    // build reads only refs and stable app members.
  }, [app]);

  return (
    <section aria-labelledby="doctor-sheet-heading" className="doctor-sheet-section">
      <SectionHead icon="file" id="doctor-sheet-heading" title="Doctor sheet">
        <span className="no-print">
          A summary of your strong and possible matches to take to your doctor, made in this browser from a fresh match over every loaded node. Nothing
          is sent.
        </span>
      </SectionHead>
      <div className="row no-print">
        <button type="button" id="doctor-sheet-build" disabled={busy} onClick={() => void run("built")}>
          {sheet === null ? "Show doctor sheet" : "Refresh doctor sheet"}
        </button>
        <button type="button" id="doctor-sheet-print" className="secondary" disabled={busy} onClick={() => void run("printed")}>
          Print
        </button>
        <button type="button" id="doctor-sheet-download" className="secondary" disabled={busy} onClick={() => void run("downloaded")}>
          Download .txt
        </button>
      </div>
      {error !== "" ? (
        <p role="alert" className="error">
          The doctor sheet could not be made: {error}
        </p>
      ) : null}
      <p role="status" className="visually-hidden" id="doctor-sheet-status">
        {announcement}
      </p>
      {sheet !== null ? <SheetView sheet={sheet} /> : null}
      {sheet !== null && printRoot !== null ? createPortal(<SheetView sheet={sheet} printCopy />, printRoot) : null}
    </section>
  );
}

/** `printCopy`: the copy in #print-root, without ids (they stay unique on the page). */
function SheetView({ sheet, printCopy = false }: { sheet: DoctorSheetModel; printCopy?: boolean }) {
  const p = sheet.profile;
  const id = (value: string) => (printCopy ? undefined : value);
  return (
    <article id={id("doctor-sheet")} className="doctor-sheet" data-studies={sheet.studies.length} data-generated={sheet.generatedAt} aria-hidden={printCopy || undefined}>
      <h3>Clinical trial pre-screening summary</h3>
      <p className="disclaimer" id={id("doctor-sheet-disclaimer")}>
        {sheet.disclaimer}
      </p>
      <p className="muted">
        Record as of {sheet.asOf}. Prepared {sheet.generatedAt.slice(0, 16).replace("T", " ")} UTC in the patient&apos;s browser.
      </p>
      <h4>Patient summary (only the record items these studies refer to)</h4>
      <dl className="facts">
        <dt>Age range</dt>
        <dd>{p.ageBand ?? "unknown"}</dd>
        <dt>Sex</dt>
        <dd>{p.sex}</dd>
        <dt>Diagnoses</dt>
        <dd>{p.conditions.join("; ") || "none relevant"}</dd>
        <dt>Labs</dt>
        <dd>{p.labs.join("; ") || "none relevant"}</dd>
        <dt>Medications</dt>
        <dd>{p.medications.join("; ") || "none relevant"}</dd>
      </dl>
      <h4>
        Strong and possible matches ({sheet.studies.length})
      </h4>
      {sheet.studies.length === 0 ? <p>No study looked like a strong or possible match on the coded criteria.</p> : null}
      {sheet.studies.map((s) => (
        <div key={s.nct_id} className="sheet-study" data-nct={s.nct_id} data-verdict={s.verdict}>
          <h5>
            {s.nct_id}: {s.title}
          </h5>
          <p>
            {s.verdict === "strong_match" ? "Strong match" : "Possible match"}: met {s.counts.met}, unknown {s.counts.unknown}, not met {s.counts.not_met}.
            Trial node: {s.node}.
          </p>
          <p className="muted">
            Source:{" "}
            {s.ctgovUrl !== null ? (
              <a href={s.ctgovUrl} rel="noreferrer noopener" target="_blank">
                {s.ctgovUrl}
              </a>
            ) : (
              "ClinicalTrials.gov"
            )}{" "}
            (ClinicalTrials.gov snapshot {s.retrieved})
          </p>
          {s.criteria.length > 0 ? (
            <ul className="reasons">
              {s.criteria.map((c, i) => (
                <li key={i} data-status={c.status}>
                  <strong>{STATUS_LABEL[c.status]}</strong> ({c.type}): {c.label}
                  <div className="muted">{c.reason}</div>
                </li>
              ))}
            </ul>
          ) : null}
          {s.freeText.length > 0 ? (
            <>
              <p>
                <strong>For the doctor or study team to check</strong> (the record cannot answer these):
              </p>
              <ul className="free-text">
                {s.freeText.map((f, i) => (
                  <li key={i}>
                    ({f.type}) {f.label}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ))}
      {sheet.notEligible > 0 ? <p className="muted">{sheet.notEligible} other studies did not fit on a coded criterion.</p> : null}
      {sheet.notIncluded.length > 0 ? (
        <ul className="muted" id={id("doctor-sheet-not-included")}>
          {sheet.notIncluded.map((m) => (
            <li key={m.origin}>
              Not included: {m.node} ({m.origin}): {m.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">ClinicalTrials.gov snapshot dates: {sheet.snapshots.join(", ") || "none"}.</p>
    </article>
  );
}
