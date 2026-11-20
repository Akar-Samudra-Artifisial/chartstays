"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { inquiryDraft, inquiryFields, type InquiryApproval, type InquiryField, type InquiryStudy } from "../../lib/inquiry";
import { phiSegments, scanText, type ProfileTerms } from "../../lib/phi-scan";
import { DATA_DELETED_EVENT, loadProfile } from "../profile-store";
import type { MatchApp } from "./match-app";
import { PhiHighlight, ScanStatus } from "./phi-highlight";

interface Pending {
  study: InquiryStudy;
  via: "agent" | "user";
  fields: InquiryField[];
  terms: ProfileTerms;
  resolve: (approval: InquiryApproval | null) => void;
}

/**
 * prepareInquiry's dialog: the patient picks which record items, if any, go into a message for
 * the study team, sees the full text with the health-data scanner's highlights, then copies or
 * downloads it. Nothing is sent; the study team is contacted through ClinicalTrials.gov. The
 * trust log gets field names and counts only.
 */
export default function InquiryDialog({ app }: { app: MatchApp }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState<{ study: InquiryStudy; via: "agent" | "user"; draft: string } | null>(null);
  const [note, setNote] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const pendingRef = useRef<Pending | null>(null);
  /** True from the moment a request is accepted (before any await) until it is answered. */
  const busyRef = useRef(false);

  useEffect(() => {
    app.desk.setOpener(async ({ study, via }) => {
      // One inquiry at a time: a request while another is being opened or shown is declined at once.
      if (busyRef.current) {
        app.log.record({ type: "inquiry", nct_id: study.nct_id, via, action: "refused", detail: "another inquiry is already open" });
        return null;
      }
      busyRef.current = true;
      try {
        const profile = await loadProfile();
        const terms = await app.terms();
        if (profile === null || terms === null) {
          app.log.record({ type: "inquiry", nct_id: study.nct_id, via, action: "refused", detail: "no health record is imported" });
          busyRef.current = false;
          return null;
        }
        const fields = inquiryFields(study, app.session.criteriaFor(study.nct_id), profile);
        app.log.record({ type: "inquiry", nct_id: study.nct_id, via, action: "opened" });
        return await new Promise<InquiryApproval | null>((resolve) => {
          const next: Pending = { study, via, fields, terms, resolve };
          pendingRef.current = next;
          setChosen(new Set());
          setDone(null);
          setNote("");
          setPending(next);
        });
      } catch (error) {
        busyRef.current = false;
        throw error;
      }
    });
    return () => {
      app.desk.setOpener(null);
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
      busyRef.current = false;
    };
  }, [app]);

  // "Delete my data": an open draft or question goes too (answered as cancelled).
  useEffect(() => {
    const onDeleted = () => {
      const current = pendingRef.current;
      pendingRef.current = null;
      busyRef.current = false;
      setPending(null);
      setDone(null);
      setChosen(new Set());
      setNote("");
      current?.resolve(null);
    };
    window.addEventListener(DATA_DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(DATA_DELETED_EVENT, onDeleted);
  }, []);

  const stage = pending !== null ? "choose" : done !== null ? "done" : "closed";
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (stage === "closed") {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    // Focus follows the stage: the title while choosing, the finished message afterwards.
    if (stage === "choose") titleRef.current?.focus();
    else draftRef.current?.focus();
  }, [stage]);

  const draft = pending === null ? "" : inquiryDraft(pending.study, pending.fields, chosen);
  const scan = useMemo(() => (pending === null ? null : scanText(draft, pending.terms)), [draft, pending]);

  function finish(approval: InquiryApproval | null): void {
    const current = pendingRef.current;
    if (current === null) return;
    pendingRef.current = null;
    busyRef.current = false;
    setPending(null);
    current.resolve(approval);
  }

  function cancel(): void {
    const current = pendingRef.current;
    if (current !== null) {
      app.log.record({ type: "inquiry", nct_id: current.study.nct_id, via: current.via, action: "cancelled" });
      finish(null);
    }
    setDone(null);
  }

  function prepare(): void {
    if (pending === null || scan === null) return;
    const fields = pending.fields.filter((f) => chosen.has(f.key)).map((f) => f.key);
    app.log.record({ type: "inquiry", nct_id: pending.study.nct_id, via: pending.via, action: "prepared", fields, phiFields: scan.spans.length });
    setDone({ study: pending.study, via: pending.via, draft });
    setNote("Your message is ready below. Copy or download it; nothing was sent.");
    finish({ nct_id: pending.study.nct_id, fields, phiFields: scan.spans.length, draft });
  }

  function toggle(key: string, on: boolean): void {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setChosen(next);
  }

  async function copy(): Promise<void> {
    if (done === null) return;
    try {
      await navigator.clipboard.writeText(done.draft);
      setNote("Copied. Paste it into a message to the study team (contact details are on its ClinicalTrials.gov page).");
      app.log.record({ type: "inquiry", nct_id: done.study.nct_id, via: done.via, action: "copied" });
    } catch {
      setNote("Copying was not allowed by the browser; select the text above and copy it, or download it.");
    }
  }

  function download(): void {
    if (done === null) return;
    const url = URL.createObjectURL(new Blob([done.draft], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `inquiry-${done.study.nct_id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setNote("Downloaded. It is a file on your device; nothing was sent.");
    app.log.record({ type: "inquiry", nct_id: done.study.nct_id, via: done.via, action: "downloaded" });
  }

  const study = pending?.study ?? done?.study ?? null;
  return (
    <dialog
      ref={dialogRef}
      id="inquiry-dialog"
      className="consent"
      aria-labelledby="inquiry-title"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      {study !== null ? (
        <div>
          <h2 id="inquiry-title" ref={titleRef} tabIndex={-1}>
            Message to the study team for {study.nct_id}
          </h2>
          <p className="muted">
            ChartStays does not send this message. You copy or download it and contact the study team yourself through{" "}
            {study.ctgovUrl !== null ? (
              <a href={study.ctgovUrl} rel="noreferrer noopener" target="_blank" id="inquiry-ctgov">
                its ClinicalTrials.gov page
              </a>
            ) : (
              "its ClinicalTrials.gov page"
            )}
            . {pending?.via === "agent" ? "The assistant asked for this draft; it only learns which items you chose, not the text." : null}
          </p>
          {pending !== null && scan !== null ? (
            <>
              <fieldset id="inquiry-fields">
                <legend>Add details from your record (optional, none by default)</legend>
                {pending.fields.map((f) => (
                  <label key={f.key} className="inquiry-field">
                    <input
                      type="checkbox"
                      id={`inquiry-field-${f.key.replace(/[^a-z0-9-]/gi, "-")}`}
                      data-field={f.key}
                      checked={chosen.has(f.key)}
                      onChange={(e) => toggle(f.key, e.target.checked)}
                    />{" "}
                    {f.label}
                  </label>
                ))}
              </fieldset>
              <h3>Full text</h3>
              <pre className="inquiry-preview" id="inquiry-preview">
                <PhiHighlight segments={phiSegments(draft, scan.spans)} />
              </pre>
              <p className="scan-line" aria-live="polite">
                Health-data scan: <ScanStatus id="inquiry-scan-status" found={scan.spans.length} />
              </p>
              <div className="row">
                <button type="button" id="inquiry-prepare" onClick={prepare}>
                  Prepare this text
                </button>
                <button type="button" id="inquiry-cancel" className="secondary" onClick={cancel}>
                  Cancel
                </button>
              </div>
            </>
          ) : null}
          {done !== null ? (
            <>
              <label htmlFor="inquiry-draft">Your message</label>
              <textarea id="inquiry-draft" ref={draftRef} readOnly rows={12} value={done.draft} />
              <div className="row">
                <button type="button" id="inquiry-copy" onClick={() => void copy()}>
                  Copy
                </button>
                <button type="button" id="inquiry-download" onClick={download}>
                  Download .txt
                </button>
                <button type="button" id="inquiry-close" className="secondary" onClick={() => setDone(null)}>
                  Close
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {/* Persistent live region: present before its text changes. */}
      <p role="status" className="muted" id="inquiry-note">
        {note}
      </p>
    </dialog>
  );
}
