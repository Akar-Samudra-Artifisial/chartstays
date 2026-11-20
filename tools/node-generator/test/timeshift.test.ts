import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PATHS } from "../src/paths.ts";
import { TIMESHIFT_REFERENCE, collectDates, dayNumber, shiftValue, timeshiftBundle, yearsBetween, type Json } from "../src/timeshift.ts";

interface ShiftedEntry {
  file: string;
  offset_days: number;
  original_latest: string;
}

const index = JSON.parse(readFileSync(path.join(PATHS.syntheaShifted, "index.json"), "utf8")) as ShiftedEntry[];
const read = (dir: string, file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8"));

test("shiftValue keeps precision, time of day and offset", () => {
  assert.equal(shiftValue("2024-02-28", 2), "2024-03-01");
  assert.equal(shiftValue("2024-12-31T23:59:59.123-05:00", 1), "2025-01-01T23:59:59.123-05:00");
  assert.equal(shiftValue("2024-05", 40), "2024-06");
  assert.equal(shiftValue("2024", 400), "2025");
  assert.equal(shiftValue("2026-11-01", -365), "2025-11-01");
});

test("only date-typed keys are shifted; codes that look like years are untouched", () => {
  const bundle: Json = {
    resourceType: "Bundle",
    entry: [
      { resource: { resourceType: "Patient", birthDate: "1970-01-10" } },
      { resource: { resourceType: "MedicationRequest", authoredOn: "2020-01-01", medicationCodeableConcept: { coding: [{ code: "6809" }] } } },
      { resource: { resourceType: "Observation", effectivePeriod: { start: "2020-06-01T10:00:00Z", end: "2020-06-02" }, valueString: "2020-06-01" } },
    ],
  };
  const { bundle: out, offsetDays, latest } = timeshiftBundle(bundle, "2020-06-12");
  assert.equal(latest, "2020-06-02");
  assert.equal(offsetDays, 10);
  const json = JSON.stringify(out);
  assert.ok(json.includes('"code":"6809"'));
  assert.ok(json.includes('"valueString":"2020-06-01"'));
  assert.ok(json.includes('"birthDate":"1970-01-20"'));
  assert.ok(json.includes('"start":"2020-06-11T10:00:00Z"'));
  assert.equal(JSON.stringify(bundle).includes("1970-01-20"), false, "input is not mutated");
});

test("every subset patient has a shifted copy", () => {
  const originals = (JSON.parse(readFileSync(path.join(PATHS.syntheaPatients, "index.json"), "utf8")) as { file: string }[]).map((e) => e.file);
  assert.deepEqual(index.map((e) => e.file), originals);
});

for (const entry of index) {
  const name = entry.file.split("_")[0];
  test(`${name}: one offset for every date, order kept, latest date is the reference, nothing in the future, same age`, () => {
    const original = read(PATHS.syntheaPatients, entry.file);
    const shifted = read(PATHS.syntheaShifted, entry.file);
    const before = collectDates(original);
    const after = collectDates(shifted);
    assert.equal(after.length, before.length);
    const offsets = new Set(before.map(([, d], i) => dayNumber(after[i]![1]) - dayNumber(d)));
    assert.deepEqual([...offsets], [entry.offset_days], "one offset per patient");
    for (let i = 1; i < before.length; i += 1) {
      assert.equal(Math.sign(before[i]![1].localeCompare(before[0]![1])), Math.sign(after[i]![1].localeCompare(after[0]![1])));
    }
    const sortedBefore = before.map(([, d], i) => [d, i] as const).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]).map(([, i]) => i);
    const sortedAfter = after.map(([, d], i) => [d, i] as const).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]).map(([, i]) => i);
    assert.deepEqual(sortedAfter, sortedBefore, "date order is kept");
    const clinical = after.filter(([key]) => key !== "birthDate").map(([, d]) => d);
    assert.equal(clinical.reduce((a, b) => (b > a ? b : a)), TIMESHIFT_REFERENCE);
    assert.ok(after.every(([, d]) => d <= TIMESHIFT_REFERENCE), "no date after the reference");
    const birth = before.find(([key]) => key === "birthDate")![1];
    const newBirth = after.find(([key]) => key === "birthDate")![1];
    assert.equal(yearsBetween(newBirth, TIMESHIFT_REFERENCE), yearsBetween(birth, entry.original_latest));
    // The committed copy is what the script produces now.
    assert.deepEqual(shifted, timeshiftBundle(original).bundle);
  });
}
