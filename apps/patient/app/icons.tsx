import type { ReactNode } from "react";

/**
 * Inline SVG icons (24×24, 2px stroke, currentColor). Decorative: always aria-hidden, the text next
 * to an icon carries the meaning. No icon font or external file, so nothing new for the CSP.
 */
export type IconName =
  | "shield"
  | "lock"
  | "building"
  | "cpu"
  | "check"
  | "check-circle"
  | "help-circle"
  | "x-circle"
  | "alert"
  | "chat"
  | "arrow-right"
  | "file"
  | "clock"
  | "eye"
  | "send"
  | "user"
  | "zap"
  | "download"
  | "search"
  | "filter";

const PATHS: Record<IconName, ReactNode> = {
  shield: <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.4 7.5 9.5 4.4-1.1 7.5-4.9 7.5-9.5V6L12 3Z" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
      <path d="M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.8 2.8L16.5 9.5" />
    </>
  ),
  "help-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01" />
    </>
  ),
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  alert: <path d="M12 4 2.8 19.5h18.4L12 4ZM12 10v4.5M12 17.5h.01" />,
  chat: <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12Z" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  send: <path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  zap: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z" />,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className === undefined ? "icon" : `icon ${className}`}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** A card heading row: icon tile, optional step tag, the heading itself and a one-line description. */
export function SectionHead({
  icon,
  step,
  title,
  id,
  level = 2,
  children,
  tabIndex,
}: {
  icon: IconName;
  step?: number;
  title: string;
  id: string;
  level?: 2 | 3;
  children?: ReactNode;
  tabIndex?: number;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="section-head">
      <span className="section-icon">
        <Icon name={icon} />
      </span>
      <div className="section-head-text">
        <Heading id={id} tabIndex={tabIndex}>
          {step !== undefined ? (
            <>
              <span className="step-tag">
                Step {step}
                <span className="visually-hidden">:</span>
              </span>{" "}
            </>
          ) : null}
          {title}
        </Heading>
        {children !== undefined ? <p className="section-desc">{children}</p> : null}
      </div>
    </div>
  );
}

/** A small stacked bar: criteria that fit, are still to confirm, and do not fit. SVG attributes only (no inline style). */
export function CriteriaBar({ fit, confirm, against }: { fit: number; confirm: number; against: number }) {
  const total = Math.max(1, fit + confirm + against);
  const w = (n: number) => (n / total) * 100;
  return (
    <svg className="crit-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect className="crit-bar-track" x="0" y="0" width="100" height="6" />
      <rect className="crit-bar-fit" x="0" y="0" width={w(fit)} height="6" />
      <rect className="crit-bar-confirm" x={w(fit)} y="0" width={w(confirm)} height="6" />
      <rect className="crit-bar-against" x={w(fit) + w(confirm)} y="0" width={w(against)} height="6" />
    </svg>
  );
}

/** A short inline explanation of a term: a native disclosure, so it works with keyboard and screen readers. */
export function Hint({ term, children }: { term: string; children: ReactNode }) {
  return (
    <details className="hint">
      <summary>
        <Icon name="help-circle" />
        {term}
      </summary>
      <p>{children}</p>
    </details>
  );
}
