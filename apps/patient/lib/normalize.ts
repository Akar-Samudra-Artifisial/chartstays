// Text normalization for the Agent Firewall's scans, so look-alike spellings cannot slip past
// a pattern: Unicode compatibility forms (NFKC: full-width letters, ligatures), invisible
// characters (zero-width, bidi controls, soft hyphen), accents, common Cyrillic and Greek
// look-alikes of Latin letters, percent-encoding, "_" and "-" used as separators, number
// words ("type two") and letters spelled out with spaces ("d i a b e t e s").
// Every normalized character remembers which characters of the original it came from, so a
// match found in the normalized form can be highlighted in the original text.

/** Normalized text with, per character, the range [start, end) of the original it came from. */
export interface MappedText {
  text: string;
  start: number[];
  end: number[];
}

/** Characters that render as nothing (or only change direction): format controls and variation selectors. */
const INVISIBLE = /^[\p{Cf}͏ᅟᅠ᠋-᠏ㅤ︀-️ﾠ]$/u;
const MARKS = /\p{M}/gu;

/** Cyrillic and Greek letters that look like Latin ones, plus typographic quotes. */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", һ: "h", ԛ: "q", ԝ: "w", ү: "y",
  А: "A", В: "B", Е: "E", Ё: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", Ѕ: "S", І: "I", Ї: "I", Ј: "J", Ԁ: "D", Һ: "H", Ԛ: "Q", Ԝ: "W", Ү: "Y",
  // Greek
  α: "a", β: "b", γ: "y", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  // Latin look-alikes outside ASCII
  ı: "i", ȷ: "j", ɡ: "g", ɑ: "a",
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-",
};

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

/**
 * NFKC, without invisible characters and accents, with look-alike letters mapped to Latin.
 * Case is kept.
 */
export function canonical(text: string): MappedText {
  const out: MappedText = { text: "", start: [], end: [] };
  let at = 0;
  const parts: string[] = [];
  for (const ch of text) {
    const from = at;
    at += ch.length;
    if (INVISIBLE.test(ch)) continue;
    const plain = ch.normalize("NFKC").normalize("NFD").replace(MARKS, "");
    for (const c of plain) {
      const mapped = HOMOGLYPHS[c] ?? c;
      for (let i = 0; i < mapped.length; i += 1) {
        out.start.push(from);
        out.end.push(at);
      }
      parts.push(mapped);
    }
  }
  out.text = parts.join("");
  return out;
}

/**
 * Replace every match of `pattern` (global) in `input`; each replacement character maps to
 * the whole original range of its match, the rest is copied with its mapping.
 */
function replaceMapped(input: MappedText, pattern: RegExp, replace: (match: RegExpExecArray) => string): MappedText {
  const out: MappedText = { text: "", start: [], end: [] };
  const parts: string[] = [];
  let at = 0;
  const copy = (from: number, to: number): void => {
    parts.push(input.text.slice(from, to));
    for (let i = from; i < to; i += 1) {
      out.start.push(input.start[i]!);
      out.end.push(input.end[i]!);
    }
  };
  pattern.lastIndex = 0;
  for (let m = pattern.exec(input.text); m !== null; m = pattern.exec(input.text)) {
    if (m[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    copy(at, m.index);
    const replacement = replace(m);
    const s = input.start[m.index]!;
    const e = input.end[m.index + m[0].length - 1]!;
    parts.push(replacement);
    for (let i = 0; i < replacement.length; i += 1) {
      out.start.push(s);
      out.end.push(e);
    }
    at = m.index + m[0].length;
  }
  copy(at, input.text.length);
  out.text = parts.join("");
  return out;
}

function decodePercent(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    return run;
  }
}

/** Lower case, one character at a time (so the mapping stays one to one). */
function lower(input: MappedText): MappedText {
  const chars = [...input.text];
  if (chars.length !== input.text.length) {
    // Astral characters: lower-case each UTF-16 unit range as a whole code point.
    return replaceMapped(input, /[\s\S]/gu, (m) => m[0].toLowerCase());
  }
  return { ...input, text: chars.map((c) => (c.toLowerCase().length === 1 ? c.toLowerCase() : c)).join("") };
}

/**
 * The form the firewall scans: canonical, percent-decoded, lower case, "_" and "-" as
 * spaces, number words as digits and runs of whitespace as one space.
 */
export function scanBase(text: string): MappedText {
  let m = canonical(text);
  // Percent-encoding, decoded (twice, for double encoding); a run that does not decode is kept.
  for (let i = 0; i < 2; i += 1) {
    m = replaceMapped(m, /(?:%[0-9a-f]{2})+/gi, (x) => canonical(decodePercent(x[0])).text);
  }
  m = lower(m);
  m = replaceMapped(m, /[_\-­]+/g, () => " ");
  m = replaceMapped(m, /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (x) => NUMBER_WORDS[x[0]]!);
  m = replaceMapped(m, /\s+/g, () => " ");
  return m;
}

/** `base` with letters and digits spelled out one by one joined ("d i a b e t e s" -> "diabetes"). */
function joinSpelled(base: MappedText): MappedText {
  return replaceMapped(base, /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][ .]){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu, (x) => x[0].replace(/[ .]/g, ""));
}

/** The forms a scan should search: the base form, and the base form with spelled-out words joined. */
export function scanForms(text: string): MappedText[] {
  const base = scanBase(text);
  const joined = joinSpelled(base);
  return joined.text === base.text ? [base] : [base, joined];
}

/** The base scan form as a plain string (for terms and patterns). */
export function normalizeForScan(text: string): string {
  return scanBase(text).text;
}

/** The original range of [start, end) in a mapped text. */
export function originalRange(m: MappedText, start: number, end: number): { start: number; end: number } {
  return { start: m.start[start] ?? 0, end: m.end[end - 1] ?? m.start[start] ?? 0 };
}

/** True when `text` holds characters other than printable ASCII (space to tilde). */
export function hasNonAscii(text: string): boolean {
  return /[^\x20-\x7e]/.test(text);
}
