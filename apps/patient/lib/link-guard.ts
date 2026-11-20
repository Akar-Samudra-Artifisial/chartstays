// Links in the assistant's answers. The runtime renders markdown links as plain <a> elements
// (public/runtime/cruse-render.js), and an answer can carry a link a trial node's text put
// there. A click handler on the assistant's container lets through only links to
// ClinicalTrials.gov, the directory's trial nodes and this site; any other link is blocked and
// shown to the patient in full, with an option to open it without its query string (where
// data would most likely be smuggled).

export const CTGOV_ORIGINS = ["https://clinicaltrials.gov", "https://www.clinicaltrials.gov"] as const;

export type LinkVerdict = { allowed: true; url: string } | { allowed: false; url: string; withoutQuery: string | null };

/** Whether a link may open: http(s) only, and only to an allow-listed origin. */
export function checkLink(href: string, allowedOrigins: ReadonlySet<string>, base?: string): LinkVerdict {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { allowed: false, url: href, withoutQuery: null };
  }
  const web = url.protocol === "https:" || url.protocol === "http:";
  if (web && allowedOrigins.has(url.origin) && url.username === "" && url.password === "") return { allowed: true, url: url.href };
  return { allowed: false, url: url.href, withoutQuery: web ? `${url.origin}${url.pathname}` : null };
}

export function allowedLinkOrigins(selfOrigin: string, nodeOrigins: readonly string[]): Set<string> {
  return new Set([selfOrigin, ...CTGOV_ORIGINS, ...nodeOrigins]);
}

/**
 * Block disallowed link clicks under `root` (capture phase, so it runs before anything the
 * runtime adds). Returns a function that removes the handler.
 */
export function guardLinks(
  root: HTMLElement,
  allowedOrigins: ReadonlySet<string>,
  onBlocked: (verdict: Extract<LinkVerdict, { allowed: false }>) => void,
): () => void {
  const handler = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (target === null || !root.contains(target)) return;
    const verdict = checkLink(target.getAttribute("href") ?? "", allowedOrigins, root.ownerDocument.baseURI);
    if (verdict.allowed) {
      // Never hand this page to the opened tab.
      target.setAttribute("rel", "noopener noreferrer");
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    onBlocked(verdict);
  };
  root.addEventListener("click", handler, true);
  root.addEventListener("auxclick", handler, true);
  return () => {
    root.removeEventListener("click", handler, true);
    root.removeEventListener("auxclick", handler, true);
  };
}
