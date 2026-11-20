// TypeScript mirror of schema/criteria.schema.json. Keep both in sync.

export type CriterionType = "inclusion" | "exclusion";

export interface CriteriaSource {
  name: "ClinicalTrials.gov";
  nct_id: string;
  /** https://clinicaltrials.gov/study/<NCT id> */
  url: string;
  /** Date (YYYY-MM-DD) the record was downloaded from the ClinicalTrials.gov API. */
  retrieved: string;
  /** lastUpdatePostDate of the record at retrieval time. */
  last_update_posted?: string;
  /** What ChartStays changed relative to the ClinicalTrials.gov record. */
  modified: string;
}

export interface Eligibility {
  /** eligibilityCriteria exactly as published. */
  criteria_text: string;
  sex: "ALL" | "FEMALE" | "MALE";
  minimum_age: string | null;
  maximum_age: string | null;
  healthy_volunteers?: boolean | null;
}

interface CriterionBase {
  id: string;
  type: CriterionType;
  label: string;
  /** The criterion text this entry was mapped from. */
  source_text: string;
  note?: string;
  /**
   * Logic group id. Criteria sharing a group come from one source line and are combined
   * with `group_logic` instead of the default rule (every inclusion must be met; any met
   * exclusion excludes). Set together with `group_logic`.
   */
  group?: string;
  /** "any": one member decides the group; "all": every member must be met. */
  group_logic?: GroupLogic;
}

export type GroupLogic = "all" | "any";

export interface AgeCriterion extends CriterionBase {
  kind: "age";
  min: number | null;
  max: number | null;
  unit: "years";
}

export interface SexCriterion extends CriterionBase {
  kind: "sex";
  sex: "female" | "male";
}

export interface ConditionCriterion extends CriterionBase {
  kind: "condition";
  /**
   * The study requires the area's main condition (inclusion only). A record without it
   * does not meet the criterion; absence of any other inclusion condition is unknown.
   */
  primary?: true;
  codes: { snomed: string[] };
}

export type LabOp = "lt" | "lte" | "gt" | "gte" | "between";

export interface LabCriterion extends CriterionBase {
  kind: "lab";
  loinc: string;
  op: LabOp;
  value: number | [number, number];
  unit: string;
}

export interface MedicationCriterion extends CriterionBase {
  kind: "medication";
  rxnorm: string[];
}

export type StructuredCriterion =
  | AgeCriterion
  | SexCriterion
  | ConditionCriterion
  | LabCriterion
  | MedicationCriterion;

export interface FreeTextCriterion {
  id: string;
  type: CriterionType;
  text: string;
}

export interface CriteriaDocument {
  schema_version: 1;
  nct_id: string;
  title: string;
  status: string;
  conditions: string[];
  source: CriteriaSource;
  eligibility: Eligibility;
  structured: StructuredCriterion[];
  free_text: FreeTextCriterion[];
  requested_fields_for_inquiry: string[];
  curation?: { method: "manual" | "llm-assisted+manual-review"; notes?: string };
}
