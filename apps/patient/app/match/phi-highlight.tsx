import type { PhiSegment } from "../../lib/phi-scan";

/** Text with each detected health-data term marked and labelled with its kind (not by colour alone). */
export function PhiHighlight({ segments, id }: { segments: readonly PhiSegment[]; id?: string }) {
  return (
    <span className="phi-text" id={id}>
      {segments.map((s, i) =>
        s.kind === undefined ? (
          <span key={i}>{s.text}</span>
        ) : (
          <mark key={i} className="phi" data-kind={s.kind}>
            {s.text}
            <span className="phi-kind"> ({s.kind})</span>
          </mark>
        ),
      )}
    </span>
  );
}

/**
 * "Clean" or "Blocked" with a text label. Not a live region itself (lists show many of these);
 * a view that updates it puts it in one persistent live container.
 */
export function ScanStatus({ found, id }: { found: number; id?: string }) {
  const blocked = found > 0;
  return (
    <span className={`scan-status ${blocked ? "scan-blocked" : "scan-clean"}`} data-status={blocked ? "blocked" : "clean"} id={id}>
      {blocked ? `Blocked: ${found} health-data ${found === 1 ? "item" : "items"} found` : "Clean: the scanner found no health data from your record"}
    </span>
  );
}
