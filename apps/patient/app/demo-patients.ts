// The bundled synthetic demo patients (public/demo-patients/), read and imported in this browser.
import { parseBundleText, type PatientProfile } from "@chartstays/fhir-profile";
import { saveProfile } from "./profile-store";

export type DemoPatient = { id: string; area: string; label: string; file: string };

/** The patient the one-click demo loads: type 2 diabetes has the clearest mix of verdicts. */
export const DEFAULT_DEMO_ID = "demo-type-2-diabetes";

export async function listDemoPatients(): Promise<DemoPatient[]> {
  const response = await fetch("/demo-patients/index.json", { credentials: "omit" });
  return response.ok ? ((await response.json()) as DemoPatient[]) : [];
}

/** Reads a FHIR bundle text into a profile and saves it in this browser (the bundle itself is not kept). */
export async function importBundleText(text: string): Promise<PatientProfile> {
  const profile = parseBundleText(text, { asOf: new Date() });
  await saveProfile(profile);
  return profile;
}

export async function importDemoPatient(demo: DemoPatient): Promise<PatientProfile> {
  const response = await fetch(demo.file, { credentials: "omit" });
  if (!response.ok) throw new Error(`Demo file returned HTTP ${response.status}`);
  return importBundleText(await response.text());
}
