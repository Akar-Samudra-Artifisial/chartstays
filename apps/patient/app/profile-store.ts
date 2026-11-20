// The imported profile lives only in this browser's IndexedDB. The raw FHIR bundle is never stored.
import { isPatientProfile, type PatientProfile } from "@chartstays/fhir-profile";
import { deleteModelCache } from "../lib/webllm-client";
import { clearBrowserStorage } from "./browser-storage";

const DB_NAME = "chartstays";
const STORE = "profile";
const KEY = "current";

/** Dispatched on window by deleteAllData; the /match page clears its in-memory trust log on it. */
export const DATA_DELETED_EVENT = "chartstays:data-deleted";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function open(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
  };
  return request(req);
}

/** The saved profile, or null when none is saved or it is not a current-schema profile. */
export async function loadProfile(): Promise<PatientProfile | null> {
  const db = await open();
  try {
    const value: unknown = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(KEY));
    return isPatientProfile(value) ? value : null;
  } finally {
    db.close();
  }
}

export async function saveProfile(profile: PatientProfile): Promise<void> {
  const db = await open();
  try {
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(profile, KEY));
  } finally {
    db.close();
  }
}

/**
 * Delete the whole database, not just the record, plus the agent runtime's browser storage
 * (BYOK keys and profiles, cookie) and the downloaded local model. When another tab holds the database open, the deletion
 * waits: `onPending` is called and the promise resolves once the other tabs are closed.
 */
export function deleteAllData(onPending?: () => void): Promise<void> {
  clearBrowserStorage({ localStorage: window.localStorage, sessionStorage: window.sessionStorage, document, pathname: window.location.pathname });
  // The /match page's in-memory trust log (and window.__chartstays, which reads it) is emptied too.
  window.dispatchEvent(new Event(DATA_DELETED_EVENT));
  const database = new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("Could not delete the IndexedDB database"));
    req.onblocked = () => onPending?.();
  });
  // The downloaded local model (Cache Storage) goes too, and its worker is stopped.
  const model = deleteModelCache().catch((error: unknown) => {
    throw new Error(`Could not delete the downloaded local model: ${error instanceof Error ? error.message : String(error)}`);
  });
  return Promise.all([database, model]).then(() => undefined);
}
