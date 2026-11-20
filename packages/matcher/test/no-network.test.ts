// Matching runs on the patient's device: neither the matcher nor the profile builder may
// reach the network.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const FORBIDDEN = /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|RTCPeerConnection)\b|\bimport\s*\(/;

for (const pkg of ["matcher", "fhir-profile"]) {
  test(`packages/${pkg}/src uses no network API`, () => {
    const dir = new URL(`../../${pkg}/src/`, import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const lines = readFileSync(new URL(file, dir), "utf8").split("\n");
      lines.forEach((line, i) => assert.ok(!FORBIDDEN.test(line), `${pkg}/src/${file}:${i + 1} uses a network API: ${line.trim()}`));
    }
  });
}

test("the forbidden-API pattern catches the usual calls", () => {
  for (const sample of ["await fetch(url)", "new XMLHttpRequest()", "new WebSocket(u)", "navigator.sendBeacon(u, d)", "await import(u)"]) {
    assert.ok(FORBIDDEN.test(sample), sample);
  }
});
