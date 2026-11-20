// Split ClinicalTrials.gov eligibility text into numbered criterion lines.
//
// The text is Markdown-like: "Inclusion Criteria:" / "Exclusion Criteria:" headings and
// "* " bullets, sometimes with indented sub-bullets. Each top-level bullet becomes one
// line; sub-bullets and continuation lines are appended to their parent so a line keeps
// its context ("Any of the following: a; b").

import type { CriterionType } from "@chartstays/criteria-schema";

export interface EligibilityLine {
  /** inc-<n> or exc-<n>, numbered from 1 per section in text order. */
  id: string;
  type: CriterionType;
  text: string;
}

const HEADING = /^\s*(?:[#*_]+\s*)?(inclusion|exclusion)(?:\s+criteria)?\b[^a-z]*[:.]?\s*[*_]*\s*$/i;
const BULLET = /^(\s*)(?:[*\-•+]|\d{1,2}[.)]|[a-z][.)])\s+(.*)$/i;

/** Undo the Markdown escaping and HTML entities ClinicalTrials.gov uses (\>, &lt;, ...). */
export function unescapeCtgov(text: string): string {
  return text
    .replace(/\\([^\w\s])/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&le;/g, "≤")
    .replace(/&ge;/g, "≥")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// "...; 5. Serum ferritin" or "... at screening. 6. Voluntary": a numbered criterion that
// the record ran into the previous one. A capital letter must follow the number so
// decimals and sub-item references ("grade 2. 3 cycles") are left alone.
const INLINE_NUMBER = /[;.]\s+\d{1,2}\.\s+(?=[A-Z])/;

/** Split one criterion text where the record ran further numbered criteria into it. */
export function splitInlineNumbering(text: string): string[] {
  return text
    .split(INLINE_NUMBER)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function splitEligibility(raw: string): EligibilityLine[] {
  const items: { type: CriterionType; parts: string[] }[] = [];
  let type: CriterionType = "inclusion";
  let current: { type: CriterionType; parts: string[] } | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const heading = HEADING.exec(line);
    if (heading) {
      type = heading[1]!.toLowerCase() === "exclusion" ? "exclusion" : "inclusion";
      current = null;
      continue;
    }
    const bullet = BULLET.exec(line);
    const text = (bullet ? bullet[2]! : line).trim();
    if (text === "") continue;
    const nested = bullet !== null && bullet[1]!.length >= 2;
    if (current && (nested || !bullet)) {
      current.parts.push(text);
    } else {
      current = { type, parts: [text] };
      items.push(current);
    }
  }

  const counters = { inclusion: 0, exclusion: 0 };
  return items
    .map((item) => ({ type: item.type, text: unescapeCtgov(item.parts.join("; ").replace(/:;/g, ":")) }))
    .flatMap((item) => splitInlineNumbering(item.text).map((text) => ({ type: item.type, text })))
    .filter((item) => item.text !== "")
    .map((item) => {
      counters[item.type] += 1;
      const prefix = item.type === "inclusion" ? "inc" : "exc";
      return { id: `${prefix}-${counters[item.type]}`, type: item.type, text: item.text };
    });
}
