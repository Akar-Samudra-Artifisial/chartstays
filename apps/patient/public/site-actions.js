// ChartStays site actions for the agent runtime (manifest actions.module).
// The logic lives in the app bundle (lib/site-actions.ts); the page sets
// globalThis.__chartstaysSiteActions before it boots the runtime. Without that the module
// fails closed: no action is registered, so the agent cannot read the record or load nodes.
// Another site's bridge or a page without the patient app gets nothing.
export async function registerActions(actions) {
  const definitions = globalThis.__chartstaysSiteActions;
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error("ChartStays site actions are not available on this page.");
  }
  for (const definition of definitions) actions.register(definition);
}
