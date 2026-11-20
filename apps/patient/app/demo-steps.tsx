import { Icon } from "./icons";

export type DemoStep = 1 | 2 | 3 | 4;

const STEPS: ReadonlyArray<{ n: DemoStep; label: string; short: string; href: string }> = [
  { n: 1, label: "Choose a patient", short: "Patient", href: "/#get-started" },
  { n: 2, label: "Allow trial sites", short: "Sites", href: "/match#find-heading" },
  { n: 3, label: "See matches", short: "Matches", href: "/match#results-area" },
  { n: 4, label: "Ask the assistant", short: "Assistant", href: "/match#agent-heading" },
];

type DemoStepsProps = {
  current?: DemoStep;
  label?: string;
  /** Compact strip (number + one-word label in a single row), for the first screen on phones. */
  compact?: boolean;
  className?: string;
};

/**
 * The four-step demo path. `current` is the step to do next; earlier steps are marked done.
 * Without `current` (state not known yet, or the overview on the landing page) no step is marked.
 * The current step is announced through aria-current; done steps get a text label, not only colour.
 */
export default function DemoSteps({ current, label = "Demo steps", compact = false, className }: DemoStepsProps) {
  const classes = ["demo-steps", compact ? "demo-steps-compact" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <nav aria-label={label} className={classes}>
      <ol>
        {STEPS.map((s) => {
          const state = current === undefined ? "todo" : s.n < current ? "done" : s.n === current ? "current" : "todo";
          return (
            <li key={s.n} data-state={state}>
              <a href={s.href} aria-current={state === "current" ? "step" : undefined}>
                <span className="step-num" aria-hidden="true">
                  {state === "done" ? <Icon name="check" /> : s.n}
                </span>
                <span className="step-label">
                  <span className="visually-hidden">Step {s.n}: </span>
                  {compact ? (
                    <>
                      <span aria-hidden="true">{s.short}</span>
                      <span className="visually-hidden">{s.label}</span>
                    </>
                  ) : (
                    s.label
                  )}
                  {state === "done" ? <span className="visually-hidden"> (done)</span> : null}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
