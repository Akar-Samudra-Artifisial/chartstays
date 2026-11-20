// Clear what the app and the vendored agent runtime (public/runtime: byok.js, engine.js)
// keep in this browser: BYOK keys and profiles (localStorage, sessionStorage, cookie
// nsweb_byok_profiles_v1) and network link keys. The runtime files are not changed; the
// app clears the storage areas of its own origin.

export interface ClearableStorage {
  clear(): void;
}

export interface CookieJar {
  cookie: string;
}

export interface BrowserStorage {
  localStorage?: ClearableStorage;
  sessionStorage?: ClearableStorage;
  document?: CookieJar;
  /** Current path, so cookies set without Path=/ are expired too. */
  pathname?: string;
}

/** Cookie names readable from script (HttpOnly cookies are not visible and not set by the app). */
export function cookieNames(cookie: string): string[] {
  return cookie
    .split(";")
    .map((part) => part.split("=")[0]?.trim() ?? "")
    .filter((name) => name !== "");
}

/** Empty localStorage and sessionStorage and expire every script-visible cookie of this origin. */
export function clearBrowserStorage(env: BrowserStorage): void {
  env.localStorage?.clear();
  env.sessionStorage?.clear();
  const jar = env.document;
  if (jar === undefined) return;
  const paths = new Set(["/", env.pathname ?? "/"]);
  for (const name of cookieNames(jar.cookie)) {
    for (const path of paths) jar.cookie = `${name}=; Max-Age=0; Path=${path}; SameSite=Lax`;
  }
}
