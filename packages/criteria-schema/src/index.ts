import { readFileSync } from "node:fs";
import type { CriteriaDocument } from "./types.ts";
import { createCriteriaValidator, type ValidationResult } from "./validate.ts";

export type * from "./types.ts";
export { createCriteriaValidator, type ValidationResult } from "./validate.ts";

/** The JSON Schema for criteria.json, draft-07. */
export const criteriaSchema: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("../schema/criteria.schema.json", import.meta.url), "utf8"),
);

const validate = createCriteriaValidator(criteriaSchema);

/**
 * Validate a parsed criteria document against the schema, then check rules JSON Schema
 * cannot express: unique ids, id prefix matching type, nct_id agreement, age ranges.
 */
export function validateCriteria(doc: unknown): ValidationResult {
  return validate(doc);
}

/** True when a criteria document has at least one structured criterion besides age. */
export function hasNonAgeStructured(doc: CriteriaDocument): boolean {
  return doc.structured.some((c) => c.kind !== "age");
}
