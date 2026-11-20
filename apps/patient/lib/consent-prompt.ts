// The pending consent question behind the dialog. Kept outside React so that unmounting the
// dialog can answer a waiting question with "deny" (and so it can be tested without a DOM):
// a matching run never hangs on a dialog that is gone.
import type { ConsentRequest } from "./consent.ts";
import type { ConsentDecision } from "./trust-log.ts";

export class ConsentPromptHost {
  #pending: { request: ConsentRequest; resolve: (decision: ConsentDecision) => void } | null = null;
  #disposed = false;
  #listeners = new Set<() => void>();

  /** Pass to ConsentManager.setPrompt. */
  readonly prompt = (request: ConsentRequest): Promise<ConsentDecision> =>
    new Promise<ConsentDecision>((resolve) => {
      // A question the firewall found health data in is never put to the patient (fail closed).
      if (this.#disposed || request.scan?.status === "blocked") {
        resolve("deny");
        return;
      }
      // ConsentManager asks one question at a time; an older one still open is denied.
      this.#pending?.resolve("deny");
      this.#pending = { request, resolve };
      this.#changed();
    });

  current(): ConsentRequest | null {
    return this.#pending?.request ?? null;
  }

  answer(decision: ConsentDecision): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#changed();
    pending.resolve(decision);
  }

  /** Deny the open question and every later one. */
  dispose(): void {
    this.#disposed = true;
    this.answer("deny");
    this.#listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
