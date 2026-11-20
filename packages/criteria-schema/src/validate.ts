// Environment-neutral criteria validation: no file system access, so browsers can use it.
// The caller passes the JSON Schema (index.ts reads it from disk; a browser bundle imports
// criteria.schema.json).
import { Ajv } from "ajv";
import type { CriteriaDocument } from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Compile a validator for criteria documents: the schema, then the rules JSON Schema cannot
 * express (unique ids, id prefix matching type, nct_id agreement, age ranges, groups).
 */
export function createCriteriaValidator(schema: Record<string, unknown>): (doc: unknown) => ValidationResult {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return criteriaValidatorFrom(ajv.compile<CriteriaDocument>(schema));
}

/** A schema check compiled by Ajv, at run time or ahead of time (dist/precompiled.js). */
export interface CompiledSchemaCheck {
  (doc: unknown): boolean;
  errors?: { instancePath?: string; message?: string }[] | null;
}

/**
 * The full validator around an already compiled schema check. Browsers whose Content Security
 * Policy forbids eval use the precompiled check (./precompiled), since Ajv compiles with new Function.
 */
export function criteriaValidatorFrom(compiled: CompiledSchemaCheck): (doc: unknown) => ValidationResult {
  return (doc: unknown): ValidationResult => {
    if (!compiled(doc)) {
      const errors = (compiled.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
      return { valid: false, errors };
    }
    // The schema check passed, so the document has the CriteriaDocument shape.
    const errors = extraErrors(doc as CriteriaDocument);
    return { valid: errors.length === 0, errors };
  };
}

function extraErrors(doc: CriteriaDocument): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const all = [...doc.structured.map((c) => ({ id: c.id, type: c.type })), ...doc.free_text];
  for (const { id, type } of all) {
    if (ids.has(id)) errors.push(`duplicate criterion id ${id}`);
    ids.add(id);
    const expectedPrefix = type === "inclusion" ? "inc-" : "exc-";
    if (!id.startsWith(expectedPrefix)) errors.push(`${id}: id prefix does not match type ${type}`);
  }
  if (doc.source.nct_id !== doc.nct_id) errors.push("source.nct_id differs from nct_id");
  if (!doc.source.url.endsWith(doc.nct_id)) errors.push("source.url does not point at nct_id");
  for (const c of doc.structured) {
    if (c.kind === "age" && c.min !== null && c.max !== null && c.min > c.max) {
      errors.push(`${c.id}: age min ${c.min} is greater than max ${c.max}`);
    }
    if (c.kind === "lab" && Array.isArray(c.value) && c.value[0] > c.value[1]) {
      errors.push(`${c.id}: lab range is reversed`);
    }
    if (c.kind === "condition" && c.primary === true && c.type !== "inclusion") {
      errors.push(`${c.id}: primary is only allowed on inclusion conditions`);
    }
  }
  const groups = new Map<string, { type: string; logic: string; size: number }>();
  for (const c of doc.structured) {
    if (c.group === undefined) continue;
    const seen = groups.get(c.group);
    if (seen === undefined) {
      groups.set(c.group, { type: c.type, logic: c.group_logic ?? "", size: 1 });
      continue;
    }
    seen.size += 1;
    if (seen.type !== c.type) errors.push(`${c.id}: group ${c.group} mixes inclusion and exclusion`);
    if (seen.logic !== c.group_logic) errors.push(`${c.id}: group ${c.group} mixes group_logic values`);
  }
  for (const [group, { size }] of groups) {
    if (size < 2) errors.push(`group ${group} has only one member`);
  }
  return errors;
}
