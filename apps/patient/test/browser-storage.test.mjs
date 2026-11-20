// "Delete my data" clears the agent runtime's browser storage: the keys byok.js and
// engine.js write (public/runtime, vendored, not changed) must all be gone afterwards.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clearBrowserStorage, cookieNames } from "../app/browser-storage.ts";

class FakeStorage {
  #items = new Map();
  setItem(key, value) {
    this.#items.set(key, String(value));
  }
  getItem(key) {
    return this.#items.get(key) ?? null;
  }
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
}

// A cookie jar like document.cookie: reading lists name=value pairs, writing sets or expires one.
class FakeDocument {
  jar = new Map();
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  set cookie(text) {
    const [pair, ...attrs] = text.split(";").map((s) => s.trim());
    const [name, value] = pair.split("=");
    if (attrs.some((a) => /^Max-Age=0$/i.test(a))) this.jar.delete(name);
    else this.jar.set(name, value);
  }
}

test("clearBrowserStorage empties localStorage, sessionStorage and the BYOK cookie", () => {
  const local = new FakeStorage();
  const session = new FakeStorage();
  const doc = new FakeDocument();
  // Keys used by public/runtime/byok.js and engine.js.
  local.setItem("nsweb-byok-profiles-v1", '{"profiles":[{"key":"sk-test"}]}');
  local.setItem("nsweb-dev", "1");
  local.setItem("nsweb-railw", "1");
  local.setItem("nsdeploy-link-v1::https://example.org::net::ref", "target");
  session.setItem("nsweb-byok-tab-key", "sk-tab");
  session.setItem("nsweb-byok-key", "sk-loose");
  session.setItem("nsweb-byok-router", "openrouter");
  session.setItem("nsweb-byok-model", "model");
  doc.cookie = "nsweb_byok_profiles_v1=%7B%7D; Path=/; Max-Age=31536000; SameSite=Lax";
  doc.cookie = "other=1; Path=/";

  clearBrowserStorage({ localStorage: local, sessionStorage: session, document: doc, pathname: "/" });

  assert.equal(local.length, 0);
  assert.equal(session.length, 0);
  assert.equal(doc.cookie, "");
});

test("clearBrowserStorage tolerates missing storage areas", () => {
  assert.doesNotThrow(() => clearBrowserStorage({}));
});

test("cookieNames reads names from document.cookie", () => {
  assert.deepEqual(cookieNames("a=1; nsweb_byok_profiles_v1=%7B%7D;  b = 2"), ["a", "nsweb_byok_profiles_v1", "b"]);
  assert.deepEqual(cookieNames(""), []);
});
