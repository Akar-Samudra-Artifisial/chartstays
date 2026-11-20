// Locates the trial node template assets. The node generator fills page.html and
// copies the other assets unchanged into every node.
import { fileURLToPath } from "node:url";

/** Absolute path of the folder holding page.html, node.css and site-actions.js. */
export const assetsDir = fileURLToPath(new URL("./assets/", import.meta.url));

/** Assets copied verbatim into each node, relative to assetsDir. */
export const staticAssets = ["site-actions.js", "node.css"];

/** The page template, with {{TOKEN}} slots the generator fills with escaped HTML. */
export const pageTemplate = "page.html";

/** Tokens page.html must contain; the generator fails when one is not filled. */
export const pageTokens = [
  "NODE_TITLE",
  "NODE_DESCRIPTION",
  "STUDY_COUNT",
  "STUDY_LIST",
  "RETRIEVED",
  "THEME_PRIMARY",
];
