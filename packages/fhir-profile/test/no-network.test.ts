// The profile builder must never reach the network: patient data stays in the browser.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const FORBIDDEN = /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|RTCPeerConnection)\b|\bimport\s*\(/;

test("src/ uses no network API", () => {
  const dir = new URL("../src/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const lines = readFileSync(new URL(file, dir), "utf8").split("\n");
    lines.forEach((line, i) => assert.ok(!FORBIDDEN.test(line), `${file}:${i + 1} uses a network API: ${line.trim()}`));
  }
});
