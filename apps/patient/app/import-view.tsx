"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { FhirImportError, MAX_BUNDLE_BYTES, type PatientProfile } from "@chartstays/fhir-profile";
import { KEY_LABS } from "../lib/key-labs";
import { DEFAULT_DEMO_ID, importBundleText, importDemoPatient, listDemoPatients, type DemoPatient } from "./demo-patients";
import DemoSteps from "./demo-steps";
import { Icon } from "./icons";
import { deleteAllData, loadProfile } from "./profile-store";

/** A profile older than this is flagged: the record may have changed since the import. */
const STALE_AFTER_DAYS = 30;
const MAX_MB = MAX_BUNDLE_BYTES / (1024 * 1024);

function daysSince(date: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
}

function errorText(error: unknown): string {
  if (error instanceof FhirImportError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export default function ImportView() {
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [demos, setDemos] = useState<DemoPatient[]>([]);
  const [demosLoading, setDemosLoading] = useState(true);
  const [demoId, setDemoId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    loadProfile()
      .then((stored) => setProfile(stored))
      .catch((e: unknown) => setError(`Could not read saved data: ${errorText(e)}`))
      .finally(() => setLoaded(true));
    listDemoPatients()
      .then((list) => {
        setDemos(list);
        setDemoId((list.find((d) => d.id === DEFAULT_DEMO_ID) ?? list[0])?.id ?? "");
      })
      .catch(() => setDemos([]))
      .finally(() => setDemosLoading(false));
  }, []);

  function imported(next: PatientProfile, source: string): void {
    setError("");
    setProfile(next);
    setStatus(`Imported ${source}. The profile is saved in this browser only.`);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    try {
      if (file.size > MAX_BUNDLE_BYTES) throw new Error(`The file is larger than ${MAX_MB} MB.`);
      setStatus("");
      setError("");
      imported(await importBundleText(await file.text()), file.name);
    } catch (e) {
      setError(`Import failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function onDemo(): Promise<void> {
    const demo = demos.find((d) => d.id === demoId);
    if (demo === undefined) return;
    setBusy(true);
    try {
      setStatus("");
      setError("");
      imported(await importDemoPatient(demo), `demo patient (${demo.label})`);
    } catch (e) {
      setError(`Import failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(): Promise<void> {
    if (!window.confirm("Delete your imported record, assistant settings and any downloaded local model from this browser?")) return;
    setBusy(true);
    try {
      await deleteAllData(() => setStatus("Deletion pending until other ChartStays tabs are closed."));
      setProfile(null);
      setError("");
      setStatus("Your data, including any downloaded local model, was deleted from this browser.");
      headingRef.current?.focus();
    } catch (e) {
      setError(`Delete failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const disorders = profile?.conditions.filter((c) => c.active && /\((disorder|disease)\)$/.test(c.display)) ?? [];
  const otherActive = profile?.conditions.filter((c) => c.active && !/\((disorder|disease)\)$/.test(c.display)) ?? [];
  const labs = profile === null ? [] : KEY_LABS.filter(([code]) => profile.observations[code] !== undefined);
  const ageDays = profile === null ? 0 : daysSince(profile.asOf, new Date());

  return (
    <>
      <DemoSteps current={!loaded ? undefined : profile === null ? 1 : 2} />

      <section aria-labelledby="import-heading" className="card">
        <div className="section-head">
          <span className="section-icon">
            <Icon name="user" />
          </span>
          <div className="section-head-text">
            <h2 id="import-heading" ref={headingRef} tabIndex={-1}>
              <span className="step-tag">
                Step 1<span className="visually-hidden">:</span>
              </span>{" "}
              Choose a patient record
            </h2>
            <p className="section-desc">
              <Icon name="lock" className="icon-inline" />
              Your record stays in this browser. Files are read on this device; nothing is uploaded.
            </p>
          </div>
        </div>
        <div className="field">
          <label htmlFor="demo-patient">Synthetic demo patient (fastest way to try it)</label>
          <div className="row">
            <select id="demo-patient" value={demoId} onChange={(e) => setDemoId(e.target.value)} disabled={busy || demos.length === 0} aria-busy={demosLoading}>
              {demosLoading ? <option value="">Loading demo patients…</option> : null}
              {!demosLoading && demos.length === 0 ? <option value="">No demo patients bundled</option> : null}
              {demos.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void onDemo()} disabled={busy || demoId === ""}>
              Load demo patient
            </button>
          </div>
        </div>
        <div className="field field-file">
          <label htmlFor="fhir-file">Or your own FHIR R4 Bundle (JSON file, up to {MAX_MB} MB)</label>
          <input id="fhir-file" ref={fileInput} type="file" accept=".json,application/json,application/fhir+json" onChange={(e) => void onFile(e)} disabled={busy} />
        </div>
        <p aria-live="polite" className="status">
          {busy ? "Reading the record in this browser…" : status}
        </p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {profile !== null ? (
          <p className="next-step">
            <a className="button-link" href="/match" id="go-match">
              Find trials for this patient
              <Icon name="arrow-right" />
            </a>
          </p>
        ) : null}
      </section>

      {!loaded ? <p className="muted">Checking for a saved record…</p> : null}
      {loaded && profile === null ? <p className="muted empty-note">No record imported yet. Load a demo patient above to start.</p> : null}

      {profile !== null ? (
        <section aria-labelledby="profile-heading" className="card">
          <div className="section-head">
            <span className="section-icon">
              <Icon name="file" />
            </span>
            <div className="section-head-text">
              <h2 id="profile-heading">What ChartStays kept from the record</h2>
              <p className="section-desc">
                As of {profile.asOf}. Kept: age, sex, conditions, latest lab results and active medications. Not kept: name, address, identifiers, exact birth
                date.
              </p>
            </div>
          </div>
          {ageDays > STALE_AFTER_DAYS ? (
            <p className="warning" role="status">
              This profile was imported on {profile.asOf}, {ageDays} days ago. Your record may have changed since then: import it again for current results.
            </p>
          ) : null}
          {profile.deceased ? (
            <p className="warning" role="status">
              This record marks the patient as deceased. Trial matching does not apply; check that you imported the right record.
            </p>
          ) : null}
          <dl className="stat-grid">
            <div className="stat">
              <dt>Age</dt>
              <dd>{profile.age ?? "unknown"}</dd>
            </div>
            <div className="stat">
              <dt>Sex</dt>
              <dd>{profile.sex}</dd>
            </div>
            <div className="stat">
              <dt>Active conditions</dt>
              <dd>{disorders.length}</dd>
            </div>
            <div className="stat">
              <dt>Medications</dt>
              <dd>{profile.medications.length}</dd>
            </div>
          </dl>

          <h3>Active conditions</h3>
          {disorders.length === 0 ? <p>None recorded.</p> : (
            <ul>
              {disorders.map((c) => (
                <li key={`${c.system}|${c.code}`}>
                  {c.display}
                  {c.onset ? <span className="muted"> since {c.onset}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {otherActive.length > 0 ? (
            <details>
              <summary>{otherActive.length} other active findings</summary>
              <ul>
                {otherActive.map((c) => (
                  <li key={`${c.system}|${c.code}`}>{c.display}</li>
                ))}
              </ul>
            </details>
          ) : null}

          <h3 id="labs-heading">Latest lab results</h3>
          {labs.length === 0 ? <p>No key lab results in the record.</p> : (
          <table>
            <caption className="muted">Latest result of each key test, with its date</caption>
            <thead>
              <tr>
                <th scope="col">Test</th>
                <th scope="col">Result</th>
                <th scope="col">Date</th>
              </tr>
            </thead>
            <tbody>
              {labs.map(([code, name]) => {
                const o = profile.observations[code]!;
                return (
                  <tr key={code}>
                    <th scope="row">{name}</th>
                    <td>
                      {String(o.value)} {o.unit ?? ""}
                    </td>
                    <td>{o.date}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}

          <h3>Active medications</h3>
          {profile.medications.length === 0 ? <p>None recorded.</p> : (
            <ul>
              {profile.medications.map((m) => (
                <li key={m.rxnorm}>{m.display}</li>
              ))}
            </ul>
          )}

          <div className="row actions">
            <button type="button" className="danger" onClick={() => void onDelete()} disabled={busy}>
              Delete my data
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
