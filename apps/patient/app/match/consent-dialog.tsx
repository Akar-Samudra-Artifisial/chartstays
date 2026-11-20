"use client";

import { useEffect, useRef, useState } from "react";
import type { ConsentManager, ConsentRequest } from "../../lib/consent";
import { ConsentPromptHost } from "../../lib/consent-prompt";
import { phiSegments } from "../../lib/phi-scan";
import type { ConsentDecision } from "../../lib/trust-log";
import { PhiHighlight, ScanStatus } from "./phi-highlight";

/**
 * Modal consent dialog for contacting a trial node. While it is mounted it is the consent
 * manager's only prompt; closing it any way other than an allow button denies, and so does
 * unmounting it with a question open.
 */
export default function ConsentDialog({ consent }: { consent: ConsentManager }) {
  const [host, setHost] = useState<ConsentPromptHost | null>(null);
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    const next = new ConsentPromptHost();
    const unsubscribe = next.subscribe(() => {
      const current = next.current();
      if (current !== null) returnFocus.current = document.activeElement;
      setRequest(current);
    });
    consent.setPrompt(next.prompt);
    setHost(next);
    return () => {
      consent.setPrompt(null);
      unsubscribe();
      // A question still open is answered "deny", so no caller waits on a dialog that is gone.
      next.dispose();
    };
  }, [consent]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (request === null) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    denyRef.current?.focus();
  }, [request]);

  function decide(decision: ConsentDecision): void {
    if (host === null || host.current() === null) return;
    host.answer(decision);
    if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
  }

  return (
    <dialog
      ref={dialogRef}
      id="consent-dialog"
      className="consent"
      aria-labelledby="consent-title"
      aria-describedby="consent-purpose"
      onCancel={(event) => {
        event.preventDefault();
        decide("deny");
      }}
    >
      {request ? (
        <div>
          <h2 id="consent-title">Contact {request.label}?</h2>
          <dl className="facts">
            <dt>Site</dt>
            <dd id="consent-origin">{request.origin}</dd>
            <dt>Network</dt>
            <dd id="consent-network">{request.network}</dd>
            <dt>Purpose</dt>
            <dd id="consent-purpose">{request.purpose}</dd>
            {request.requestText !== undefined ? (
              <>
                <dt>Exact question sent to its assistant</dt>
                <dd>
                  <q id="consent-request-text">
                    <PhiHighlight segments={request.scan === undefined ? [{ text: request.requestText }] : phiSegments(request.requestText, request.scan.spans)} />
                  </q>
                  <div className="scan-line">
                    Health-data scan: <ScanStatus id="consent-scan-status" found={request.scan?.spans.length ?? 0} />
                  </div>
                </dd>
              </>
            ) : null}
          </dl>
          <p className="muted">Your health record stays in this browser. You can deny; the other trial sites still work.</p>
          <div className="row">
            <button type="button" id="consent-allow-once" onClick={() => decide("allow_once")}>
              Allow once
            </button>
            <button type="button" id="consent-allow-session" className="secondary" onClick={() => decide("allow_session")}>
              Allow for this session
            </button>
            <button type="button" id="consent-deny" className="secondary" ref={denyRef} onClick={() => decide("deny")}>
              Deny
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
