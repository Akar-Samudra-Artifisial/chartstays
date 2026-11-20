// Local-model debug switch (app/match/agent-panel.tsx): the prompts and raw replies of the
// in-browser model, redacted, in this browser's console.

/** localStorage key that turns the debug log on when set to "1". */
export const LLM_DEBUG_KEY = "chartstays_debug_llm";

/**
 * Off by default: only localStorage `chartstays_debug_llm` = "1", set by hand in this browser's
 * devtools. Never from the URL (no ?debugllm=1), so a link cannot turn it on. It only writes to
 * this browser's console; nothing goes to the trust log or the network.
 */
export function llmDebugEnabled(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(LLM_DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}
