"use client";

import { useState, type MouseEvent } from "react";
import { DEFAULT_DEMO_ID, importDemoPatient, listDemoPatients } from "./demo-patients";
import { Icon } from "./icons";

/**
 * One click to the matching page: imports the default synthetic patient in this browser, then
 * opens /match. Without JavaScript (or if loading fails) the link still leads to the patient picker.
 * `id` defaults to "try-demo" (the hero button); a second copy on the page needs its own id.
 */
export default function TryDemoButton({ id = "try-demo" }: { id?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onClick(event: MouseEvent<HTMLAnchorElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const demos = await listDemoPatients();
      const demo = demos.find((d) => d.id === DEFAULT_DEMO_ID) ?? demos[0];
      if (demo === undefined) throw new Error("No demo patients are bundled.");
      await importDemoPatient(demo);
      window.location.assign("/match");
    } catch (e) {
      setBusy(false);
      setError(`Could not load the demo patient: ${e instanceof Error ? e.message : String(e)}. Choose one below instead.`);
    }
  }

  return (
    <>
      <a className="button-link button-large" href="#get-started" id={id} aria-disabled={busy || undefined} onClick={(e) => void onClick(e)}>
        {busy ? "Loading the demo patient…" : "Try with a demo patient"}
        {busy ? null : <Icon name="arrow-right" />}
      </a>
      <span className="visually-hidden" aria-live="polite">
        {busy ? "Loading the demo patient in this browser, then opening Find trials." : ""}
      </span>
      {error ? (
        <p role="alert" className="error hero-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
