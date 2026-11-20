// Registers this trial node's read-only operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
// Every action reads a JSON file published next to this module. Nothing is written.

const NCT_PATTERN = "^NCT[0-9]{8}$";

/**
 * Exposes the node's published study data as read actions.
 */
class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register({
      name: "list_trials",
      description: "List the studies published on this node: NCT id, title, recruiting status, conditions, phase, sponsor, a short summary and the ClinicalTrials.gov link.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: SiteActions.listTrials,
    });
    actions.register({
      name: "get_trial_criteria",
      description: "Read one study's eligibility criteria: the original ClinicalTrials.gov text, structured criteria (age, sex, coded conditions, labs, medications) and criteria that stay free text.",
      effect: "read",
      inputSchema: SiteActions.nctInput("NCT id of a study from website_list_trials."),
      execute: SiteActions.readCriteria,
    });
    actions.register({
      name: "get_trial_logistics",
      description: "Read one study's logistics from ClinicalTrials.gov: locations and their recruiting status, start and completion dates, enrollment target, sponsor and the record link for contacts.",
      effect: "read",
      inputSchema: SiteActions.nctInput("NCT id of a study from website_list_trials."),
      execute: SiteActions.readLogistics,
    });
  }

  /**
   * Input schema for actions that take one NCT id.
   *
   * :param description: The argument description the model sees.
   * :return: The JSON Schema.
   */
  static nctInput(description) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["nct_id"],
      properties: {
        nct_id: { type: "string", pattern: NCT_PATTERN, description },
      },
    };
  }

  /**
   * :return: The node's study index.
   */
  static listTrials() {
    return SiteActions.readJson("./criteria/index.json");
  }

  /**
   * :param args: The validated arguments with nct_id.
   * :return: The study's criteria document, or ok false when the id is not on this node.
   */
  static async readCriteria(args) {
    return SiteActions.readStudyFile("criteria", args.nct_id);
  }

  /**
   * :param args: The validated arguments with nct_id.
   * :return: The study's logistics document, or ok false when the id is not on this node.
   */
  static async readLogistics(args) {
    return SiteActions.readStudyFile("logistics", args.nct_id);
  }

  /**
   * Read <folder>/<NCT id>.json after checking the id is listed in the index.
   *
   * :param folder: "criteria" or "logistics".
   * :param nctId: The requested NCT id.
   * :return: The parsed file, or {ok: false, reason, field}.
   */
  static async readStudyFile(folder, nctId) {
    const id = String(nctId || "").trim().toUpperCase();
    if (!new RegExp(NCT_PATTERN).test(id)) {
      return { ok: false, reason: "nct_id must look like NCT followed by 8 digits.", field: "nct_id" };
    }
    const index = await SiteActions.readJson("./criteria/index.json");
    if (!index.studies.some((study) => study.nct_id === id)) {
      return { ok: false, reason: `${id} is not published on this node. Call website_list_trials for the ids it has.`, field: "nct_id" };
    }
    return SiteActions.readJson(`./${folder}/${id}.json`);
  }

  /**
   * Fetch a JSON file relative to this module, without credentials.
   *
   * :param relative: The path relative to this module.
   * :return: The parsed JSON.
   * :raises Error: When the file cannot be fetched.
   */
  static async readJson(relative) {
    const response = await fetch(new URL(relative, import.meta.url), { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`${relative} fetch failed with HTTP ${response.status}`);
    }
    return response.json();
  }
}

export const registerActions = SiteActions.registerActions;
