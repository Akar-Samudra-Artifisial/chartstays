// TEST-ONLY local "BYOK" LLM router for the spec §6 interop e2e (docs/interop-s6.md). It speaks
// the OpenAI-compatible chat-completions stream the runtime's LlmClient reads
// (public/runtime/llm.js) and answers like the runtime's browser mock: it calls each offered tool
// once, in order, then sums up the tool results. It records every request (method, path, headers,
// body) so the e2e can check that the BYOK key reaches this router and nothing else.
//
// It listens on 127.0.0.1:11434 because that is the only loopback router origin the patient
// app's CSP allows (connect-src, scripts/configure-nodes.mjs DEV_ROUTER_ORIGINS, development
// builds whose nodes are all on localhost); the CSP is not loosened for the test.
//
// A user message containing "skip:<tool>" words (or "skip:<tool>,<tool>") makes it leave those tools out (the e2e uses it
// for a second chat turn that reaches peers the runtime's per-query budget skipped in the first).
import http from "node:http";

export const FAKE_ROUTER_PORT = 11434;
export const FAKE_ROUTER = `http://localhost:${FAKE_ROUTER_PORT}/v1`;
export const FAKE_MODEL = "fake-byok-model";

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m?.role === "user");
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
}

/** The next completion, as the runtime's browserMockCompletion would answer (plus "skip:"). */
export function fakeCompletion(messages = [], tools = []) {
  const request = lastUserText(messages);
  // One "skip:<tool>" word per tool: the app's firewall refuses a question with a word over 40 characters.
  const skip = new Set([...request.matchAll(/skip:([a-z0-9_,]+)/gi)].flatMap((m) => m[1].split(",")).filter(Boolean));
  // Only this turn's tool results: the runtime keeps earlier turns in the history.
  const lastUser = messages.map((m) => m?.role).lastIndexOf("user");
  const called = new Set(messages.slice(lastUser + 1).filter((m) => m?.role === "tool" && m.name).map((m) => m.name));
  const next = (tools ?? []).map((t) => t?.function).find((fn) => fn?.name && !called.has(fn.name) && !skip.has(fn.name));
  if (next) {
    const args = {};
    const schema = next.parameters ?? {};
    for (const name of schema.required ?? []) args[name] = request;
    for (const name of ["request", "inquiry", "search_terms", "query", "input"]) {
      if (schema.properties?.[name] || (schema.required ?? []).includes(name)) args[name] ??= request;
    }
    return { toolCall: { id: `call_${next.name}`, name: next.name, arguments: JSON.stringify(args) } };
  }
  const results = messages.filter((m) => m?.role === "tool").map((m) => String(m.content ?? ""));
  return { content: results.length ? `(fake BYOK router) Based on the tools I consulted: ${results.join(" ").slice(0, 1200)}` : "(fake BYOK router) Nothing to report." };
}

function sse(completion) {
  const chunk = (delta, finish) => `data: ${JSON.stringify({ model: FAKE_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  if (completion.toolCall) {
    const { id, name, arguments: args } = completion.toolCall;
    return chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
  }
  return chunk({ content: completion.content }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

/** Start the router. Returns { requests, close }. */
export function startFakeRouter() {
  const requests = [];
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors);
        response.end();
        return;
      }
      const urlPath = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method !== "POST" || urlPath !== "/v1/chat/completions") {
        response.writeHead(404, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
        response.end("Body is not JSON");
        return;
      }
      response.writeHead(200, { ...cors, "Content-Type": "text/event-stream" });
      response.end(sse(fakeCompletion(parsed.messages, parsed.tools)));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`fake BYOK router on port ${FAKE_ROUTER_PORT}: ${error.message}`)));
    server.listen(FAKE_ROUTER_PORT, "127.0.0.1", () => resolve({ requests, close: () => new Promise((r) => server.close(() => r())) }));
  });
}
