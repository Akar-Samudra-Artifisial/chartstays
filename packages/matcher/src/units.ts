// Unit handling for lab criteria. Only units listed here are understood; anything else
// makes the criterion unknown instead of being guessed. Conversions are limited to
// analyte-independent factors (no molar-mass or formula conversions).

interface UnitInfo {
  canonical: string;
  dimension: string;
  /** Multiply by this to get the dimension's base unit. */
  factor: number;
}

const UNITS: readonly (readonly [string[], UnitInfo])[] = [
  [["%"], { canonical: "%", dimension: "percent", factor: 1 }],
  [["kg/m2", "kg/m^2", "kg/m²"], { canonical: "kg/m2", dimension: "bmi", factor: 1 }],
  [["kg"], { canonical: "kg", dimension: "mass", factor: 1 }],
  [["g"], { canonical: "g", dimension: "mass", factor: 0.001 }],
  [["[lb_av]", "lb", "lbs"], { canonical: "[lb_av]", dimension: "mass", factor: 0.45359237 }],
  [["g/l"], { canonical: "g/L", dimension: "mass-concentration", factor: 1 }],
  [["g/dl"], { canonical: "g/dL", dimension: "mass-concentration", factor: 10 }],
  [["mg/dl"], { canonical: "mg/dL", dimension: "mass-concentration", factor: 0.01 }],
  [["mmol/l"], { canonical: "mmol/L", dimension: "substance-concentration", factor: 1 }],
  [["umol/l", "µmol/l"], { canonical: "umol/L", dimension: "substance-concentration", factor: 0.001 }],
  [["10*3/ul", "10^3/ul", "k/ul", "10*3/mm3", "10^3/mm3"], { canonical: "10*3/uL", dimension: "count-concentration", factor: 1 }],
  [["10*9/l", "10^9/l"], { canonical: "10*9/L", dimension: "count-concentration", factor: 1 }],
  // Albumin/creatinine ratio: 1 mg/mmol creatinine = 8.84 mg/g creatinine.
  [["mg/g"], { canonical: "mg/g", dimension: "acr", factor: 1 }],
  [["mg/mmol"], { canonical: "mg/mmol", dimension: "acr", factor: 8.84 }],
  // eGFR normalised to body surface area. Plain mL/min is a different quantity.
  [["ml/min/{1.73_m2}", "ml/min/1.73m2", "ml/min/1.73 m2", "ml/min/1.73_m2", "ml/min/{1.73m2}"], { canonical: "mL/min/{1.73_m2}", dimension: "egfr", factor: 1 }],
  [["ml/min"], { canonical: "mL/min", dimension: "flow", factor: 1 }],
  [["mm[hg]", "mmhg"], { canonical: "mm[Hg]", dimension: "pressure", factor: 1 }],
];

const LOOKUP = new Map<string, UnitInfo>(UNITS.flatMap(([aliases, info]) => aliases.map((alias) => [alias, info] as const)));

export function unitInfo(unit: string | null | undefined): UnitInfo | undefined {
  if (unit === null || unit === undefined) return undefined;
  return LOOKUP.get(unit.trim().toLowerCase());
}

export type Conversion =
  | { ok: true; value: number; converted: boolean }
  | { ok: false; reason: "unknown_unit" | "incompatible"; unit: string };

/** Convert `value` from unit `from` to unit `to`. */
export function convert(value: number, from: string | null, to: string): Conversion {
  const source = unitInfo(from);
  const target = unitInfo(to);
  if (source === undefined) return { ok: false, reason: "unknown_unit", unit: from ?? "(none)" };
  if (target === undefined) return { ok: false, reason: "unknown_unit", unit: to };
  if (source.dimension !== target.dimension) return { ok: false, reason: "incompatible", unit: source.canonical };
  if (source.canonical === target.canonical) return { ok: true, value, converted: false };
  // Round away binary floating-point noise so boundary comparisons stay exact.
  const converted = Math.round(((value * source.factor) / target.factor) * 1e9) / 1e9;
  return { ok: true, value: converted, converted: true };
}
