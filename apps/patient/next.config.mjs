import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

// Development-only pages are named page.dev.tsx (e.g. app/spike/page.dev.tsx, the runtime
// spike). They become routes only under `next dev` or with CHARTSTAYS_DEV_PAGES=1, so a
// production build (`pnpm -r build`, `pnpm deploy:check`) never exports them.
export default function nextConfig(phase) {
  const devPages = phase === PHASE_DEVELOPMENT_SERVER || process.env.CHARTSTAYS_DEV_PAGES === "1";
  /** @type {import('next').NextConfig} */
  return {
    // Static export: the agentic web needs only static files at the root of the origin.
    output: "export",
    // No basePath: the runtime fetches /agent-manifest.json, /links.json and
    // /runtime/sandbox-worker.js from the origin root.
    trailingSlash: false,
    images: { unoptimized: true },
    pageExtensions: devPages ? ["dev.tsx", "tsx", "ts", "jsx", "js"] : ["tsx", "ts", "jsx", "js"],
  };
}
