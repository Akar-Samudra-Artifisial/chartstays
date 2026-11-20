// Client-side wiring for /match: one trust log, consent manager and trial session per page.
// Compiled ahead of time: the page's CSP has no 'unsafe-eval', which Ajv's run-time compile needs.
import { validateCriteriaPrecompiled } from "@chartstays/criteria-schema/precompiled";
import { ConsentManager } from "../../lib/consent";
import { fetchDirectory, type DirectoryEntry } from "../../lib/directory";
import { AgentFirewall } from "../../lib/firewall";
import { InquiryDesk } from "../../lib/inquiry";
import { trustReport } from "../../lib/trust-report";
import { profileTerms, type ProfileTerms } from "../../lib/phi-scan";
import { createSiteActions, type SiteActionDefinition } from "../../lib/site-actions";
import { TrialSession } from "../../lib/trial-session";
import { TrustLog } from "../../lib/trust-log";
import { DATA_DELETED_EVENT, loadProfile } from "../profile-store";

export interface MatchApp {
  log: TrustLog;
  consent: ConsentManager;
  session: TrialSession;
  directory: () => Promise<DirectoryEntry[]>;
  terms: () => Promise<ProfileTerms | null>;
  firewall: AgentFirewall;
  actions: SiteActionDefinition[];
  /** prepareInquiry: the agent's request waits here for the inquiry dialog's approval. */
  desk: InquiryDesk;
  /** Fires DOCTOR_SHEET_EVENT after the agent's buildDoctorSheet, so the page shows the sheet. */
  events: EventTarget;
}

export const DOCTOR_SHEET_EVENT = "doctor-sheet";

let app: MatchApp | null = null;

export function getMatchApp(): MatchApp {
  if (app !== null) return app;
  const log = new TrustLog();
  const consent = new ConsentManager(log);
  let directoryPromise: Promise<DirectoryEntry[]> | null = null;
  const directory = () => {
    directoryPromise ??= fetchDirectory().catch((error: unknown) => {
      directoryPromise = null;
      throw error;
    });
    return directoryPromise;
  };
  const validate = validateCriteriaPrecompiled;
  const terms = async () => {
    const profile = await loadProfile();
    return profile === null ? null : profileTerms(profile);
  };
  const firewall = new AgentFirewall({ log, terms });
  const session = new TrialSession({
    firewall,
    directory,
    profile: loadProfile,
    consent,
    // The loader applies the same request rules itself (node-loader.ts); the page-wide guard
    // installed for the agent runtime (peer-fetch.ts) would only log each request twice.
    loader: { fetch: window.fetch.bind(window), validate },
    log,
  });
  const desk = new InquiryDesk();
  const events = new EventTarget();
  const actions = createSiteActions(session, loadProfile, log, { desk, onDoctorSheet: () => events.dispatchEvent(new Event(DOCTOR_SHEET_EVENT)) });
  app = { log, consent, session, directory, terms, firewall, actions, desk, events };
  // "Delete my data" also empties the in-memory trust log (window.__chartstays reads it) and any
  // inquiry approval still waiting for its action.
  window.addEventListener(DATA_DELETED_EVENT, () => {
    log.clear();
    desk.clear();
  });
  // Read-only view for automated tests and the trust panel: events hold no patient data.
  Object.defineProperty(window, "__chartstays", {
    value: Object.freeze({ trustLog: () => log.events(), trustReport: () => trustReport(log.events(), firewall.quarantined()) }),
    configurable: false,
    writable: false,
  });
  return app;
}
