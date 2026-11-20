// Local LLM router: turns the agent runtime's OpenAI Chat Completions request (messages + tools)
// into a plain chat prompt for a small model running in this browser (WebLLM, public/webllm/),
// parses the model's <tool_call> blocks strictly and answers in OpenAI's shape (JSON or SSE).
// Pure: the model is behind the LocalEngine interface, so this file runs and is tested in Node.

/** Base URL the runtime is booted with for the local model; never a network address. */
export const LOCAL_ROUTER = "browser://webllm";
export const LOCAL_ROUTE_HEADER = "local-webllm";

/** Most tool calls accepted from one model reply. */
export const MAX_TOOL_CALLS = 8;
/** Longest tool result kept in the prompt (characters). */
const MAX_TOOL_RESULT = 6_000;
/** Rough characters per token, to keep the prompt inside the model's context window. */
const CHARS_PER_TOKEN = 3;

export type PromptRole = "system" | "user" | "assistant";
export interface PromptMessage {
  role: PromptRole;
  content: string;
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

export interface OpenAiTool {
  type: "function";
  function: { name: string; description?: string; parameters?: JsonSchema };
}

export interface ChatRequest {
  model: string;
  messages: OpenAiMessage[];
  tools: OpenAiTool[];
  stream: boolean;
}

export type JsonSchema = { [key: string]: unknown };

/** The model, as the adapter sees it: chat messages in, the reply's text out. */
export interface LocalEngine {
  readonly modelId: string;
  /** Context window in tokens. */
  readonly contextTokens: number;
  /**
   * True when the engine honours `jsonSchema` (WebLLM's grammar-constrained JSON output). The
   * adapter then asks for one JSON object per reply (REPLY_FORMAT) instead of <tool_call> blocks.
   */
  readonly structured?: boolean;
  complete(messages: readonly PromptMessage[], options: { maxTokens: number; signal?: AbortSignal; jsonSchema?: string }): Promise<string>;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [{ index: 0; message: { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason: "stop" | "tool_calls" }];
}

export type ParsedReply =
  | { kind: "text"; content: string }
  | { kind: "tool_calls"; calls: { name: string; arguments: Record<string, unknown> }[] }
  | { kind: "invalid"; errors: string[] };

export class AdapterError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content.map((part) => (isPlainObject(part) && typeof part["text"] === "string" ? part["text"] : "")).join("");
  }
  return JSON.stringify(content);
}

/** Validates the request body the runtime sends (llm.js chat()). Throws AdapterError(400). */
export function parseChatRequest(body: unknown): ChatRequest {
  if (!isPlainObject(body)) throw new AdapterError(400, "The request body must be a JSON object.");
  const { model, messages, tools, stream } = body;
  if (typeof model !== "string" || model === "") throw new AdapterError(400, "model is required.");
  if (!Array.isArray(messages) || messages.length === 0) throw new AdapterError(400, "messages must be a non-empty array.");
  for (const m of messages) {
    if (!isPlainObject(m) || !["system", "user", "assistant", "tool"].includes(String(m["role"]))) throw new AdapterError(400, "Each message needs a role of system, user, assistant or tool.");
  }
  const toolList = tools === undefined ? [] : tools;
  if (!Array.isArray(toolList)) throw new AdapterError(400, "tools must be an array.");
  for (const t of toolList) {
    if (!isPlainObject(t) || t["type"] !== "function" || !isPlainObject(t["function"]) || typeof t["function"]["name"] !== "string") {
      throw new AdapterError(400, "Each tool must be {type:'function', function:{name,...}}.");
    }
  }
  return { model, messages: messages as OpenAiMessage[], tools: toolList as OpenAiTool[], stream: stream === true };
}

/** Qwen's own tool-calling instructions (the format its chat template uses). */
export function toolInstructions(tools: readonly OpenAiTool[]): string {
  if (tools.length === 0) return "";
  const signatures = tools.map((t) => JSON.stringify({ type: "function", function: { name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object", properties: {} } } }));
  return [
    "# Tools",
    "",
    "You may call one or more functions to assist with the user query.",
    "",
    "You are provided with function signatures within <tools></tools> XML tags:",
    "<tools>",
    ...signatures,
    "</tools>",
    "",
    "For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:",
    "<tool_call>",
    '{"name": <function-name>, "arguments": <args-json-object>}',
    "</tool_call>",
    "Only call the functions listed above, with arguments that match their parameters. When no function is needed, answer in plain text.",
  ].join("\n");
}

/** Argument names of a tool, for the prompt and for repair hints. */
function argumentNames(parameters: JsonSchema | undefined): string[] {
  return parameters !== undefined && isPlainObject(parameters["properties"]) ? Object.keys(parameters["properties"]) : [];
}

/** Longest parameter description in the prompt (characters). */
const MAX_PARAM_DESCRIPTION = 160;
/** A property name the prompt may show: letters, digits and underscores only. */
const PROPERTY_NAME = /^\w{1,64}$/;

/**
 * Schema text for the prompt, on one line: tool schemas can come from another site (an MCP
 * server's inputSchema), so line breaks, angle brackets (<tool_call>, <<node_text>> markers)
 * and quotes cannot start a new prompt line, block or JSON string.
 */
function promptText(value: string, max: number): string {
  return clip(value.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[<>"`]/g, "").replace(/\s{2,}/g, " ").trim(), max);
}

/** One line per argument: `name (type, required): description`; names that are not plain words are left out. */
function describeArguments(parameters: JsonSchema | undefined): string {
  const properties = parameters !== undefined && isPlainObject(parameters["properties"]) ? parameters["properties"] : {};
  const required = parameters !== undefined && Array.isArray(parameters["required"]) ? parameters["required"] : [];
  const names = Object.keys(properties).filter((name) => PROPERTY_NAME.test(name));
  if (names.length === 0) return "no arguments, pass {}";
  return names
    .map((name) => {
      const p = isPlainObject(properties[name]) ? properties[name] : {};
      const type = typeof p["type"] === "string" && PROPERTY_NAME.test(p["type"]) ? p["type"] : "value";
      const desc = typeof p["description"] === "string" ? promptText(p["description"], MAX_PARAM_DESCRIPTION) : "";
      return `"${name}" (${type}${required.includes(name) ? ", required" : ", optional"})${desc !== "" ? `: ${desc}` : ""}`;
    })
    .join("; ");
}

/**
 * Tool instructions for an engine with grammar-constrained JSON output: short, one line per tool,
 * an example per reply kind. The grammar (replySchema) makes names and arguments exact.
 */
export function structuredToolInstructions(tools: readonly OpenAiTool[]): string {
  if (tools.length === 0) return "";
  return [
    "# Tools",
    "Reply with exactly one JSON object and nothing else.",
    'To call tools: {"tool_calls": [{"name": "<tool name>", "arguments": {...}}]}',
    'To answer the user: {"final": "<your answer>"}',
    "Call a tool whenever its result is needed; do not say what you are going to do, call it. Before any tool result is in this conversation, reply with tool_calls. Answer with final only from tool results you already have.",
    "Tools:",
    ...tools.map((t) => `- ${t.function.name}: ${promptText(t.function.description ?? "", 220)} Arguments: ${describeArguments(t.function.parameters)}.`),
  ].join("\n");
}

/** Only the JSON Schema keywords the grammar needs; validateArguments still checks the rest. */
function grammarSchema(schema: JsonSchema | undefined): JsonSchema {
  if (schema === undefined) return { type: "object", properties: {}, additionalProperties: false };
  const out: JsonSchema = {};
  for (const key of ["type", "enum", "required"]) if (schema[key] !== undefined) out[key] = schema[key];
  if (isPlainObject(schema["items"])) out["items"] = grammarSchema(schema["items"]);
  if (schema["type"] === "object" || isPlainObject(schema["properties"])) {
    const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
    out["type"] = "object";
    out["properties"] = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, grammarSchema(isPlainObject(v) ? v : {})]));
    out["additionalProperties"] = false;
  }
  return out;
}

/**
 * The JSON Schema the model's reply must follow (WebLLM response_format json_object):
 * {"tool_calls":[{name, arguments}]} with each tool's own arguments, or {"final": text}.
 * `toolsOnly` leaves out "final" (the nudge after a reply that only announced a tool call).
 * An irreversible tool (`irreversible` names) is only ever called alone, once per reply; `maxCalls`
 * limits every reply (1 for a locked next step).
 */
export function replySchema(tools: readonly OpenAiTool[], toolsOnly = false, options: { irreversible?: ReadonlySet<string>; maxCalls?: number } = {}): JsonSchema {
  const final = { type: "object", properties: { final: { type: "string" } }, required: ["final"], additionalProperties: false };
  if (tools.length === 0) return final;
  const call = (t: OpenAiTool) => ({
    type: "object",
    properties: { name: { type: "string", enum: [t.function.name] }, arguments: grammarSchema(t.function.parameters) },
    required: ["name", "arguments"],
    additionalProperties: false,
  });
  const callList = (list: readonly OpenAiTool[], maxItems: number) => ({
    type: "object",
    properties: { tool_calls: { type: "array", items: { anyOf: list.map(call) }, minItems: 1, maxItems } },
    required: ["tool_calls"],
    additionalProperties: false,
  });
  const max = Math.min(options.maxCalls ?? MAX_TOOL_CALLS, MAX_TOOL_CALLS);
  const once = tools.filter((t) => options.irreversible?.has(t.function.name) === true);
  const others = tools.filter((t) => !once.includes(t));
  const branches = [...(others.length > 0 ? [callList(others, max)] : []), ...(once.length > 0 ? [callList(once, 1)] : [])];
  const calls = branches.length === 1 ? branches[0]! : { anyOf: branches };
  return toolsOnly ? calls : { anyOf: [...(branches.length === 1 ? [calls] : branches), final] };
}

/** Errors when a reply calls an irreversible tool more than once or together with another call. */
function irreversibleErrors(calls: readonly { name: string }[], irreversible: ReadonlySet<string>): string[] {
  const hits = calls.filter((c) => irreversible.has(c.name));
  if (hits.length === 0 || calls.length === 1) return [];
  return [`${hits[0]!.name} must be the only tool call in its reply (call 1 of ${calls.length})`];
}

function renderToolCalls(raw: unknown, structured = false): string {
  if (!Array.isArray(raw)) return "";
  const calls = raw
    .map((tc) => {
      const fn = isPlainObject(tc) && isPlainObject(tc["function"]) ? tc["function"] : null;
      if (fn === null || typeof fn["name"] !== "string") return null;
      let args: unknown = {};
      try {
        args = typeof fn["arguments"] === "string" && fn["arguments"] !== "" ? JSON.parse(fn["arguments"]) : {};
      } catch {
        args = {};
      }
      return { name: fn["name"], arguments: args };
    })
    .filter((c) => c !== null);
  if (calls.length === 0) return "";
  if (structured) return JSON.stringify({ tool_calls: calls });
  return calls.map((c) => `<tool_call>\n${JSON.stringify(c)}\n</tool_call>`).join("\n");
}

/**
 * The prompt for the local model: one system message first (the runtime's system messages and
 * the tool instructions), tool results as user turns, consecutive turns of one role merged, the
 * last turn from the user, and the oldest turns dropped to fit `budgetChars`.
 */
export function buildPrompt(request: Pick<ChatRequest, "messages" | "tools">, budgetChars: number, structured = false): PromptMessage[] {
  const instructions = structured ? structuredToolInstructions(request.tools) : toolInstructions(request.tools);
  const system = [...request.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)), instructions]
    .filter((s) => s.trim() !== "")
    .join("\n\n");
  const turns: PromptMessage[] = [];
  const push = (role: Exclude<PromptRole, "system">, content: string) => {
    if (content.trim() === "") return;
    const last = turns.at(-1);
    if (last !== undefined && last.role === role) turns[turns.length - 1] = { role, content: `${last.content}\n\n${content}` };
    else turns.push({ role, content });
  };
  for (const m of request.messages) {
    if (m.role === "user") push("user", textOf(m.content));
    else if (m.role === "assistant") {
      const calls = renderToolCalls(m.tool_calls, structured);
      const text = textOf(m.content);
      // In JSON mode the model's own earlier turns are shown in the format it must reply in.
      push("assistant", structured ? (calls !== "" ? calls : text.trim() === "" ? "" : JSON.stringify({ final: text })) : [text, calls].filter((s) => s !== "").join("\n"));
    }
    else if (m.role === "tool") {
      const name = typeof m.name === "string" ? m.name : "tool";
      // A tool result cannot close its own block or open a tool call in the prompt.
      const body = clip(textOf(m.content), MAX_TOOL_RESULT).replace(/<\/?\s*(?:tool_response|tool_call|tools)\b[^>]*>/gi, "");
      push("user", `<tool_response name="${name.replace(/[^\w-]/g, "")}">\n${body}\n</tool_response>`);
    }
  }
  if (turns.at(-1)?.role !== "user") throw new AdapterError(400, "The last message must come from the user or a tool.");

  // Drop the oldest turns until the prompt fits; keep at least the last one and start on a user turn.
  const size = () => system.length + turns.reduce((n, t) => n + t.content.length, 0);
  while (turns.length > 1 && size() > budgetChars) turns.shift();
  while (turns.length > 1 && turns[0]!.role !== "user") turns.shift();
  const last = turns[turns.length - 1]!;
  if (size() > budgetChars) turns[turns.length - 1] = { role: last.role, content: clip(last.content, Math.max(1_000, budgetChars - system.length)) };
  return system === "" ? turns : [{ role: "system", content: system }, ...turns];
}

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  object: isPlainObject,
  array: Array.isArray,
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

/** A strict subset of JSON Schema: type, properties, required, no extra keys, enum, lengths, items, ranges. */
export function validateArguments(schema: JsonSchema | undefined, value: unknown, path = "arguments"): string[] {
  if (schema === undefined) return isPlainObject(value) && Object.keys(value).length === 0 ? [] : [`${path}: this tool takes no arguments`];
  const errors: string[] = [];
  const type = schema["type"];
  if (typeof type === "string") {
    const check = TYPE_CHECKS[type];
    if (check !== undefined && !check(value)) return [`${path}: expected ${type}`];
  }
  if (Array.isArray(schema["enum"]) && !schema["enum"].some((e) => e === value)) errors.push(`${path}: not one of the allowed values`);
  if (typeof value === "string") {
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) errors.push(`${path}: longer than ${schema["maxLength"]} characters`);
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) errors.push(`${path}: shorter than ${schema["minLength"]} characters`);
  }
  if (typeof value === "number") {
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) errors.push(`${path}: above ${schema["maximum"]}`);
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) errors.push(`${path}: below ${schema["minimum"]}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) errors.push(`${path}: more than ${schema["maxItems"]} items`);
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) errors.push(`${path}: fewer than ${schema["minItems"]} items`);
    const items = schema["items"];
    if (isPlainObject(items)) value.forEach((item, i) => errors.push(...validateArguments(items, item, `${path}[${i}]`)));
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? schema["required"].filter((k): k is string => typeof k === "string") : [];
    for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    const extraAllowed = schema["additionalProperties"] === true;
    for (const [key, item] of Object.entries(value)) {
      const sub = properties[key];
      if (isPlainObject(sub)) errors.push(...validateArguments(sub, item, `${path}.${key}`));
      else if (!extraAllowed) errors.push(`${path}.${key}: unknown argument`);
    }
  }
  return errors;
}

/** Removes Qwen3's reasoning block (also an unterminated one). */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
}

const CALL_BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/g;
/** One Markdown code fence around a block's JSON (small models often add it); nothing else is unwrapped. */
const JSON_FENCE = /^```(?:json)?[ \t]*\n?([\s\S]*?)\n?[ \t]*```$/;

function unfence(text: string): string {
  const fenced = JSON_FENCE.exec(text);
  return fenced === null ? text : fenced[1]!.trim();
}

/**
 * The model reply as plain text or tool calls. Strict: every block must be one JSON object with
 * exactly "name" and "arguments", name a known tool, arguments valid for its schema, at most
 * MAX_TOOL_CALLS blocks. One bad block rejects the whole reply, so no partial plan ever runs.
 */
export function parseModelReply(raw: string, tools: readonly OpenAiTool[]): ParsedReply {
  const text = stripThinking(raw);
  // A tool call written as bare JSON (often cut off) is not an answer: it never reaches the patient.
  if (/^\{\s*"tool_calls"\s*:/.test(text)) return { kind: "invalid", errors: ["tool calls go inside <tool_call> blocks; this reply was bare or incomplete JSON"] };
  if (!text.includes("<tool_call>") && !text.includes("</tool_call>")) return { kind: "text", content: text };
  const byName = new Map(tools.map((t) => [t.function.name, t.function]));
  const errors: string[] = [];
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const blocks = [...text.matchAll(CALL_BLOCK)];
  const rest = text.replace(CALL_BLOCK, "");
  if (blocks.length === 0 || rest.includes("<tool_call>") || rest.includes("</tool_call>")) errors.push("a <tool_call> block is not closed");
  if (blocks.length > MAX_TOOL_CALLS) errors.push(`more than ${MAX_TOOL_CALLS} tool calls in one reply`);
  for (const [n, block] of blocks.slice(0, MAX_TOOL_CALLS).entries()) {
    const label = `call ${n + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfence(block[1]!.trim()));
    } catch {
      errors.push(`${label}: not valid JSON`);
      continue;
    }
    checkCall(parsed, label, byName, errors, calls);
  }
  return errors.length > 0 ? { kind: "invalid", errors } : { kind: "tool_calls", calls };
}

/** One {name, arguments} call, checked against the tools; pushes either an error or the call. */
function checkCall(
  parsed: unknown,
  label: string,
  byName: Map<string, OpenAiTool["function"]>,
  errors: string[],
  calls: { name: string; arguments: Record<string, unknown> }[],
): void {
  if (!isPlainObject(parsed)) {
    errors.push(`${label}: must be a JSON object`);
    return;
  }
  const extra = Object.keys(parsed).filter((k) => k !== "name" && k !== "arguments");
  if (extra.length > 0) errors.push(`${label}: unexpected keys ${extra.join(", ")}`);
  const name = parsed["name"];
  const fn = typeof name === "string" ? byName.get(name) : undefined;
  if (typeof name !== "string" || fn === undefined) {
    errors.push(`${label}: unknown tool ${JSON.stringify(typeof name === "string" ? clip(name, 80) : name)}`);
    return;
  }
  const args = parsed["arguments"] ?? {};
  if (!isPlainObject(args)) {
    errors.push(`${label}: arguments must be a JSON object`);
    return;
  }
  const argErrors = validateArguments(fn.parameters ?? { type: "object", properties: {} }, args);
  if (argErrors.length > 0) errors.push(...argErrors.map((e) => `${label} (${name}): ${e}`));
  else calls.push({ name, arguments: args });
}

/**
 * {"final": "… cut off by the token limit: the text so far, so the JSON wrapper never reaches the
 * patient. Null when the reply does not start as a final answer.
 */
export function truncatedFinal(text: string): string | null {
  const m = /^\{\s*"final"\s*:\s*"/.exec(text);
  if (m === null) return null;
  let body = text.slice(m[0].length).replace(/"\s*\}?\s*$/, "");
  for (let i = 0; i < 8; i++) {
    try {
      const kept = (JSON.parse(`"${body}"`) as string).trim();
      // Visible, so a study line cut off here is never lost without notice.
      return `${kept}${kept === "" ? "" : " "}${CUT_OFF}`;
    } catch {
      if (body.length === 0) break;
      body = body.slice(0, -1); // drop a half-written escape such as \ or \u00
    }
  }
  return CUT_OFF;
}

/** Appended to an answer the token limit cut off. */
export const CUT_OFF = "…(answer cut off — see the results list on this page)";

/** A reply that starts as JSON (`{` or `[`) but does not parse: cut off or malformed, never shown as text. */
const LOOKS_LIKE_JSON = /^[{[]/;

/**
 * A reply in the JSON format of structuredToolInstructions: {"final": text} or {"tool_calls": [...]},
 * validated as strictly as parseModelReply. Text that is not that JSON (an engine without grammar
 * support) goes through parseModelReply, so <tool_call> blocks and plain text still work.
 */
export function parseJsonReply(raw: string, tools: readonly OpenAiTool[]): ParsedReply {
  const text = unfence(stripThinking(raw));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const cut = truncatedFinal(text);
    if (cut !== null) return { kind: "text", content: cut };
    // A cut-off {"tool_calls": [... (or other broken JSON) goes to the repair path, never to the patient.
    if (LOOKS_LIKE_JSON.test(text)) return { kind: "invalid", errors: ["the reply is not complete JSON (it may have been cut off): reply with one short JSON object"] };
    return parseModelReply(raw, tools);
  }
  if (!isPlainObject(parsed)) return parseModelReply(raw, tools);
  const keys = Object.keys(parsed);
  if (keys.length === 1 && typeof parsed["final"] === "string") return { kind: "text", content: parsed["final"].trim() };
  if (!Array.isArray(parsed["tool_calls"])) return { kind: "invalid", errors: ['the reply must be {"tool_calls": [...]} or {"final": "..."}'] };
  const errors: string[] = [];
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const extra = keys.filter((k) => k !== "tool_calls");
  if (extra.length > 0) errors.push(`unexpected keys ${extra.join(", ")}`);
  const list = parsed["tool_calls"];
  if (list.length === 0) errors.push("tool_calls is empty");
  if (list.length > MAX_TOOL_CALLS) errors.push(`more than ${MAX_TOOL_CALLS} tool calls in one reply`);
  const byName = new Map(tools.map((t) => [t.function.name, t.function]));
  for (const [n, item] of list.slice(0, MAX_TOOL_CALLS).entries()) checkCall(item, `call ${n + 1}`, byName, errors, calls);
  return errors.length > 0 ? { kind: "invalid", errors } : { kind: "tool_calls", calls };
}

/** "First, let me check…": a reply that announces a tool call instead of making it. */
const ANNOUNCES_ACTION =
  /\b(let me|let's|let us|i will|i'll|i am going to|i'm going to|i need to|we need to|first,? (?:i|we)|now,? (?:i|we)|(?:is|am|are) (?:checking|loading|looking|searching|fetching|matching|reading|preparing|running))\b|(?:\.\.\.|…)\s*$/i;

/** A reply that announces work instead of doing it: intent phrases, a trailing "...", or a tool's name. */
function announcesToolCall(text: string, tools: readonly OpenAiTool[]): boolean {
  if (text.trim() === "" || ANNOUNCES_ACTION.test(text)) return true;
  return tools.some((t) => {
    const name = t.function.name;
    return text.includes(name) || (name.startsWith("website_") && new RegExp(`\\b${name.slice("website_".length)}\\b`).test(text));
  });
}

/** True when no tool has answered since the user's last message. */
function noToolResultYet(messages: readonly OpenAiMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]!.role;
    if (role === "tool") return false;
    if (role === "user") return true;
  }
  return true;
}

/** The repair hint for a rejected call: the errors and, per tool named in them, its valid arguments. */
function repairHint(errors: readonly string[], tools: readonly OpenAiTool[], structured: boolean): string {
  const named = tools.filter((t) => errors.some((e) => e.includes(`(${t.function.name})`)));
  const valid = named.map((t) => {
    const args = argumentNames(t.function.parameters);
    return `${t.function.name} takes ${args.length === 0 ? "no arguments: pass {}" : `only these arguments: ${args.join(", ")}`}`;
  });
  const format = structured ? 'Reply again with {"tool_calls": [...]} for the listed tools only, or {"final": "..."}.' : "Reply again with valid <tool_call> blocks for the listed functions only, or answer in plain text.";
  return clip(`That tool call was rejected: ${errors.slice(0, 5).join("; ")}.${valid.length > 0 ? ` ${valid.join(". ")}.` : ""} ${format}`, 1_000);
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function completionOf(model: string, reply: Exclude<ParsedReply, { kind: "invalid" }>): ChatCompletion {
  const message: ChatCompletion["choices"][0]["message"] =
    reply.kind === "text"
      ? { role: "assistant", content: reply.content }
      : {
          role: "assistant",
          content: null,
          tool_calls: reply.calls.map((c) => ({ id: nextId("call_local"), type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
        };
  return {
    id: nextId("chatcmpl_local"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.kind === "text" ? "stop" : "tool_calls" }],
  };
}

export interface CompleteOptions {
  signal?: AbortSignal;
  /** Tokens reserved for the reply. */
  maxTokens?: number;
  /** Debug mode only: receives the prompt and each raw model reply (the caller redacts and clips). */
  debug?: DebugSink;
  /** Tool names of irreversible site actions (website_prepareInquiry): offered only when an agent's instructions call them, and only alone, once per reply. */
  irreversible?: readonly string[];
}

/** Debug hook: `event` is "prompt", "reply" or "parsed"; `text` may hold health data, so the sink must redact. */
export type DebugSink = (event: string, text: string) => void;

/** Prefix the runtime gives this site's own actions (site-actions.ts) as tools. */
const SITE_TOOL_PREFIX = "website_";

/** The agent's own instructions (its system messages). */
function systemText(messages: readonly OpenAiMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
}

/**
 * Site actions an agent's instructions tell it to use: "call website_X" (any case) and, for
 * actions that are not irreversible, "… from website_X" (the partner rules: "give its link from
 * website_listNodes"). An irreversible action needs an explicit "call website_X".
 */
export function calledInInstructions(system: string, irreversible: ReadonlySet<string> = new Set()): Set<string> {
  const readFrom = [...system.matchAll(/\bfrom (website_\w+)\b/gi)].map((m) => m[1]!).filter((n) => !irreversible.has(n));
  return new Set([...explicitCalls(system), ...readFrom]);
}

/** Site actions named in "call website_X" (any case). */
function explicitCalls(system: string): Set<string> {
  return new Set([...system.matchAll(/\bcall (website_\w+)\b/gi)].map((m) => m[1]!));
}

/** A patient message that asks for one of the tasks (as opposed to a greeting or a general question). */
const TASK_INTENT = /\b(trials?|stud(?:y|ies)|match(?:es|ed|ing)?|eligib\w*|criteria|inquir\w*|enquir\w*|draft|sheet|summary|doctor|nodes?|NCT\d{8})\b/i;

/** Text of the last user message. */
function lastUserText(messages: readonly OpenAiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return textOf(messages[i]!.content);
  return "";
}

/**
 * The tools offered to the small local model. The runtime gives every agent of this site all of
 * the site's actions; here each agent gets only the website_* actions its own instructions tell it
 * to use (calledInInstructions: an allowlist per agent from its HOCON instructions). Fail-closed:
 * an agent whose instructions name no action that way gets none, and an irreversible action
 * (prepareInquiry) only with an explicit "call". The navigator names website_evaluateCriteria
 * only as the matcher behind matcher_agent, so it gets only website_listNodes (partner links), and
 * every verdict still comes through matcher_agent. Other tools (sub-agents, partners) always stay.
 */
export function focusTools(request: Pick<ChatRequest, "messages" | "tools">, irreversible: ReadonlySet<string> = new Set()): OpenAiTool[] {
  const system = systemText(request.messages);
  const allowed = calledInInstructions(system, irreversible);
  // "call website_X with no arguments": X's optional arguments leave the grammar too (a small
  // model otherwise fills them with made-up values, such as an origin that is not a node).
  const noArgs = (t: OpenAiTool) => new RegExp(`\\b${t.function.name}\\b(?: \\w+){0,2} with no arguments`).test(system);
  const bare = (t: OpenAiTool): OpenAiTool => (noArgs(t) ? { ...t, function: { ...t.function, parameters: { type: "object", properties: {} } } } : t);
  return request.tools.filter((t) => !t.function.name.startsWith(SITE_TOOL_PREFIX) || allowed.has(t.function.name)).map(bare);
}

/** A call as a comparable key: name plus arguments with sorted keys. */
function callKey(name: string, args: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  return `${name}:${JSON.stringify(canonical(args))}`;
}

/** Calls in this conversation that already have a tool result. */
function answeredCalls(messages: readonly OpenAiMessage[]): Set<string> {
  const answered = new Set(messages.filter((m) => m.role === "tool" && typeof m.tool_call_id === "string").map((m) => m.tool_call_id as string));
  const keys = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const fn = isPlainObject(tc) && isPlainObject(tc["function"]) ? tc["function"] : null;
      if (fn === null || typeof fn["name"] !== "string" || !answered.has(String(tc["id"]))) continue;
      let args: unknown = {};
      try {
        args = typeof fn["arguments"] === "string" && fn["arguments"] !== "" ? JSON.parse(fn["arguments"]) : {};
      } catch {
        continue;
      }
      keys.add(callKey(fn["name"], args));
    }
  }
  return keys;
}

/** Tool names of the last assistant turn, when tool results follow it (the previous step). */
function lastStepToolNames(messages: readonly OpenAiMessage[]): Set<string> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") continue;
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || i === messages.length - 1) return new Set();
    return new Set(
      m.tool_calls
        .map((tc) => (isPlainObject(tc) && isPlainObject(tc["function"]) && typeof tc["function"]["name"] === "string" ? tc["function"]["name"] : ""))
        .filter((n) => n !== ""),
    );
  }
  return new Set();
}

/** Every tool name the assistant has called in this conversation. */
function calledToolNames(messages: readonly OpenAiMessage[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (isPlainObject(tc) && isPlainObject(tc["function"]) && typeof tc["function"]["name"] === "string") names.add(tc["function"]["name"]);
    }
  }
  return names;
}

const STEP_PAIR = /\bcall (website_\w+)\b[^.]*?\bthen call (website_\w+)\b/g;

/**
 * The site action an agent's instructions say comes next: "first call website_A …, then call
 * website_B …" when the last step called A and B has not run yet. A small model tends to answer
 * after A's result instead of taking step B.
 */
export function nextSiteStep(request: Pick<ChatRequest, "messages" | "tools">): OpenAiTool | undefined {
  const system = systemText(request.messages);
  const last = lastStepToolNames(request.messages);
  const called = calledToolNames(request.messages);
  for (const [, first, then] of system.matchAll(STEP_PAIR)) {
    if (!last.has(first!) || called.has(then!)) continue;
    const tool = request.tools.find((t) => t.function.name === then);
    if (tool !== undefined) return tool;
  }
  return undefined;
}

/** Texts of the tool results that end the conversation (the last step's results). */
function lastToolResults(messages: readonly OpenAiMessage[]): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role === "tool"; i--) out.unshift(textOf(messages[i]!.content));
  return out;
}

const MAX_PINNED_VALUES = 50;
/** Arguments that can be pinned, and the only values they take: an NCT id. */
const PINNABLE: Record<string, RegExp> = { nct_id: /^NCT\d{8}$/ };
/** Rows whose nct_id may be pinned: the matcher's candidates, never a not_eligible study. */
const PIN_VERDICTS = new Set(["strong_match", "possible_match"]);
/** Deepest JSON nesting searched for result rows. */
const MAX_PIN_DEPTH = 8;

/**
 * Values for `key` from parsed tool results, in order: only from objects (result rows) that have
 * the key as a string and a strong or possible verdict, and only values `pattern` accepts. Text
 * from a node is a string value inside a row (marked <<node_text>>), so it can never add a row or
 * a key: a title such as `x","nct_id":"NCT…` stays inside its string.
 */
function pinnedValues(results: readonly string[], key: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  const parse = (text: string, depth: number): void => {
    try {
      walk(JSON.parse(text.replace(NODE_TEXT, "")), depth);
    } catch {
      // Not JSON (an error text): nothing to pin from.
    }
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_PIN_DEPTH || found.size >= MAX_PINNED_VALUES) return;
    // A result serialized into a string (a receipt's or a sub-agent's text); node text was removed first.
    if (typeof value === "string" && /^\s*[{[]/.test(value)) {
      parse(value, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    const candidate = value[key];
    if (typeof candidate === "string" && PIN_VERDICTS.has(String(value["verdict"])) && pattern.test(candidate)) found.add(candidate);
    for (const [k, v] of Object.entries(value)) if (k !== key) walk(v, depth + 1);
  };
  for (const text of results) parse(text, 0);
  return [...found];
}

/** A node's text as site-actions.ts marks it (untrusted()); removed before results are searched. */
const NODE_TEXT = /<<node_text>>[\s\S]*?<<\/node_text>>/g;

/**
 * The next step's tool with each pinnable argument (nct_id) limited (enum) to the values the last
 * step's parsed results give, in order: prepareInquiry's nct_id can then only be a strong or
 * possible match that evaluateCriteria returned, never one the model or a node's text made up.
 */
export function pinArguments(tool: OpenAiTool, results: readonly string[]): OpenAiTool {
  const params = tool.function.parameters;
  const props = isPlainObject(params) && isPlainObject(params["properties"]) ? params["properties"] : null;
  if (props === null) return tool;
  const pinned: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    pinned[key] = schema;
    const pattern = PINNABLE[key];
    if (pattern === undefined || !isPlainObject(schema) || schema["type"] !== "string") continue;
    const values = pinnedValues(results, key, pattern);
    if (values.length > 0) pinned[key] = { ...schema, enum: values };
  }
  return { ...tool, function: { ...tool.function, parameters: { ...params, properties: pinned } } };
}

/** Whether each required string argument of the tool has an enum (see pinArguments). */
function requiredStringsPinned(tool: OpenAiTool): boolean {
  const params = tool.function.parameters;
  const props = isPlainObject(params) && isPlainObject(params["properties"]) ? params["properties"] : {};
  const required = isPlainObject(params) && Array.isArray(params["required"]) ? params["required"] : [];
  return required.every((key) => {
    const schema = props[String(key)];
    return !isPlainObject(schema) || schema["type"] !== "string" || Array.isArray(schema["enum"]);
  });
}

/** The turn after a reply that only repeated calls whose results are already in the conversation. */
const ANSWER_NOW = "You already have the results of those calls above. Do not call them again. Answer the user now from those results.";

/** The nudge after a reply that only announced a tool call. */
const NUDGE = "Do not describe what you will do. Call the tool you need now.";

/**
 * One chat completion from the local model. With a structured engine the reply is grammar-
 * constrained JSON (replySchema), so tool names and arguments are exact. A reply that only
 * announces a tool call, before any tool answered, gets one nudge that must call a tool. An
 * invalid tool call gets one repair attempt with the errors and the valid arguments; a second
 * invalid reply becomes a plain-text error and no tool runs.
 */
export async function completeChat(engine: LocalEngine, fullRequest: ChatRequest, options: CompleteOptions = {}): Promise<ChatCompletion> {
  const irreversible = new Set(options.irreversible ?? []);
  const request: ChatRequest = { ...fullRequest, tools: focusTools(fullRequest, irreversible) };
  const maxTokens = options.maxTokens ?? 1024;
  const budget = Math.max(2_000, (engine.contextTokens - maxTokens) * CHARS_PER_TOKEN);
  const structured = engine.structured === true && request.tools.length > 0;
  const schemaOptions = { irreversible };
  const parse = (raw: string): ParsedReply => {
    const reply = structured ? parseJsonReply(raw, request.tools) : parseModelReply(raw, request.tools);
    const errors = reply.kind === "tool_calls" ? irreversibleErrors(reply.calls, irreversible) : [];
    return errors.length > 0 ? { kind: "invalid", errors } : reply;
  };
  const run = async (label: string, prompt: PromptMessage[], schema?: JsonSchema) => {
    options.debug?.(`prompt (${label})`, prompt.map((m) => `[${m.role}]\n${m.content}`).join("\n\n"));
    const raw = await engine.complete(prompt, {
      maxTokens,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(schema !== undefined ? { jsonSchema: JSON.stringify(schema) } : {}),
    });
    options.debug?.(`reply (${label})`, raw);
    return raw;
  };
  /** The conversation plus extra turns, trimmed so the whole fits the same context budget. */
  const withTurns = (turns: PromptMessage[]) => {
    const turnChars = turns.reduce((n, m) => n + m.content.length, 0);
    return [...buildPrompt(request, Math.max(1_000, budget - turnChars), structured), ...turns];
  };

  // A clear task starts with a tool call: the grammar leaves out "final" until a tool has
  // answered (a small model otherwise answers with its plan, "inquiry for NCT…", instead of
  // acting). Clear: this site's sub-agents whose instructions call a site action (their request
  // comes from the navigator), or a patient message about trials, matches, a sheet or an inquiry.
  // A greeting or a general question keeps the free choice, so it never starts a sub-agent or a
  // consent dialog. Peer requests (no website_* tools) always keep it.
  const ownSite = fullRequest.tools.some((t) => t.function.name.startsWith(SITE_TOOL_PREFIX));
  const callsSiteAction = request.tools.some((t) => t.function.name.startsWith(SITE_TOOL_PREFIX) && explicitCalls(systemText(request.messages)).has(t.function.name));
  const clearTask = ownSite && (callsSiteAction || TASK_INTENT.test(lastUserText(request.messages)));
  const mustCall = structured && clearTask && noToolResultYet(request.messages);
  let raw = await run("first", buildPrompt(request, budget, structured), structured ? replySchema(request.tools, mustCall, schemaOptions) : undefined);
  let reply = parse(raw);
  if (reply.kind === "text" && clearTask && request.tools.length > 0 && noToolResultYet(request.messages) && announcesToolCall(reply.content, request.tools)) {
    const said = structured ? JSON.stringify({ final: reply.content }) : reply.content;
    const nudge = structured ? `${NUDGE} Reply with {"tool_calls": [...]}.` : `${NUDGE} Reply with <tool_call> blocks only.`;
    raw = await run("nudge", withTurns([{ role: "assistant", content: clip(said, 1_000) }, { role: "user", content: nudge }]), structured ? replySchema(request.tools, true, schemaOptions) : undefined);
    const nudged = parse(raw);
    // Only a tool call (or a repairable attempt at one) replaces the first answer.
    if (nudged.kind !== "text") reply = nudged;
  }
  // A small model tends to call the same tool again instead of answering: one retry that must answer.
  // Repeated: the same call (name and arguments) already answered, or the same tool as the last
  // step with other wording (a sub-agent's "request"); matcher → scout → matcher stays allowed.
  const answered = answeredCalls(request.messages);
  const lastNames = lastStepToolNames(request.messages);
  // Site actions count only exactly (loadNode node after node is progress, not a repeat).
  const repeats = (c: { name: string; arguments: Record<string, unknown> }) =>
    answered.has(callKey(c.name, c.arguments)) || (!c.name.startsWith(SITE_TOOL_PREFIX) && lastNames.has(c.name));
  // The instructions' next step ("first call A, then call B") when the model answers or repeats
  // A instead: one retry whose grammar allows only B.
  const nextTool = nextSiteStep(request);
  const next = nextTool === undefined ? undefined : pinArguments(nextTool, lastToolResults(request.messages));
  // Only when every required string argument is pinned to a value from the last results: after a
  // failed step there is nothing to take the argument from, and the model would make one up.
  if (next !== undefined && requiredStringsPinned(next) && (reply.kind === "text" || (reply.kind === "tool_calls" && reply.calls.every(repeats)))) {
    const said = reply.kind === "text" ? (structured ? JSON.stringify({ final: reply.content }) : reply.content) : structured ? JSON.stringify({ tool_calls: reply.calls }) : stripThinking(raw);
    const step = `Your instructions say: now call ${next.function.name}.`;
    raw = await run("next step", withTurns([{ role: "assistant", content: clip(said, 1_000) }, { role: "user", content: structured ? `${step} Reply with {"tool_calls": [...]}.` : `${step} Reply with <tool_call> blocks only.` }]), structured ? replySchema([next], true, { irreversible, maxCalls: 1 }) : undefined);
    const stepped = parse(raw);
    if (stepped.kind !== "text") reply = stepped;
  }
  if (reply.kind === "tool_calls" && answered.size > 0 && reply.calls.every(repeats)) {
    const repeated = structured ? JSON.stringify({ tool_calls: reply.calls }) : stripThinking(raw);
    const turns: PromptMessage[] = [
      { role: "assistant", content: clip(repeated, 1_000) },
      { role: "user", content: structured ? `${ANSWER_NOW} Reply with {"final": "..."}.` : `${ANSWER_NOW} Reply in plain text.` },
    ];
    raw = await run("answer", withTurns(turns), structured ? replySchema([]) : undefined);
    const answer = parse(raw);
    if (answer.kind === "text" && answer.content !== "") reply = answer;
  }
  if (reply.kind === "invalid") {
    const turns: PromptMessage[] = [
      { role: "assistant", content: clip(stripThinking(raw), 2_000) },
      { role: "user", content: repairHint(reply.errors, request.tools, structured) },
    ];
    reply = parse(await run("repair", withTurns(turns), structured ? replySchema(request.tools, false, schemaOptions) : undefined));
  }
  if (reply.kind === "invalid") {
    return completionOf(engine.modelId, { kind: "text", content: `The local model produced an invalid tool call, so no tool was run (${clip(reply.errors.join("; "), 300)}). Please rephrase the request or use another model.` });
  }
  return completionOf(engine.modelId, reply);
}

/** The completion as OpenAI streaming chunks (Server-Sent Events), ending with [DONE]. */
export function completionToSse(completion: ChatCompletion): string {
  const { id, created, model } = completion;
  const choice = completion.choices[0];
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const parts = [chunk({ role: "assistant" }, null)];
  if (choice.message.content) parts.push(chunk({ content: choice.message.content }, null));
  for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
    parts.push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }] }, null));
  }
  parts.push(chunk({}, choice.finish_reason), "data: [DONE]\n\n");
  return parts.join("");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "X-Nsdeploy-LLM-Route": LOCAL_ROUTE_HEADER } });
}

/**
 * A fetch handler for LOCAL_ROUTER URLs: GET /models and POST /chat/completions. Answers 503
 * while no model is loaded. Nothing here makes a network request.
 */
export function createLocalRouter(engine: () => LocalEngine | null, routerOptions: { debug?: DebugSink; irreversible?: readonly string[] } = {}): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const path = url.slice(LOCAL_ROUTER.length).replace(/[?#].*$/, "").replace(/\/+$/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const current = engine();
    if (path === "/models") {
      if (method !== "GET") return jsonResponse(405, { error: { message: "Use GET for /models." } });
      return jsonResponse(200, { object: "list", data: current === null ? [] : [{ id: current.modelId, object: "model", owned_by: "local-webllm" }] });
    }
    if (path !== "/chat/completions") return jsonResponse(404, { error: { message: `Unknown local router path ${clip(path, 80)}.` } });
    if (method !== "POST") return jsonResponse(405, { error: { message: "Use POST for /chat/completions." } });
    if (current === null) return jsonResponse(503, { error: { message: "The local model is not loaded. Download and start it under Local (WebLLM) first." } });
    let request: ChatRequest;
    try {
      request = parseChatRequest(JSON.parse(typeof init?.body === "string" ? init.body : ""));
    } catch (error) {
      return jsonResponse(400, { error: { message: error instanceof Error ? error.message : "Invalid request." } });
    }
    try {
      const completion = await completeChat(current, request, {
        ...(init?.signal ? { signal: init.signal } : {}),
        ...(routerOptions.debug !== undefined ? { debug: routerOptions.debug } : {}),
        ...(routerOptions.irreversible !== undefined ? { irreversible: routerOptions.irreversible } : {}),
      });
      if (!request.stream) return jsonResponse(200, completion);
      return new Response(completionToSse(completion), { status: 200, headers: { "content-type": "text/event-stream", "X-Nsdeploy-LLM-Route": LOCAL_ROUTE_HEADER } });
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      const status = error instanceof AdapterError ? error.status : 500;
      return jsonResponse(status, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  };
}
