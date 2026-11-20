# Vendored: agentic-web

Files in this folder are copied **unchanged** from
[cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web),
licensed under the Apache License 2.0 (see `LICENSE`, copied from the same commit).

| What | Commit |
| --- | --- |
| Repository HEAD the files were copied from | `63a956cf4653f610b1c238c70946f4d7647d17a8` (2026-11-13) |
| Last commit touching `skills/agentify-website/runtime` | `0fadd4453c281178bfe41d1e30c7413ba5981696` (2026-11-13) |
| Last non-merge commit touching `runtime/`, `scripts/`, `templates/` | `d955a64b6cc2ad70f56b665fa7023fb163b80dff` (2026-11-13) |
| Conformance spec version ChartStays targets | `fd872b9221aeb8ff762b75a5badbf84b23c133cc` |

## Copied paths

- `LICENSE`
- `skills/agentify-website/runtime/` (browser runtime; copied into every node's `runtime/` and into `apps/patient/public/runtime/`)
- `skills/agentify-website/templates/` (`network.hocon` supplies the verbatim `peer_rules` and `cruse_rules`; `bridge/action-bridge.html` is used by the builder)
- `skills/agentify-website/scripts/build_network.mjs` (builder and validator; `pnpm gen` runs it, `pnpm validate` runs it with `--check`)
- `skills/agentify-website/scripts/serve_site.mjs` (reference static server, not used by the scripts)

The relative layout is kept because `build_network.mjs` reads `../templates/network.hocon`
and `../templates/bridge/action-bridge.html` relative to itself.

## Updating

Copy the same paths from a newer upstream commit, update the table above, then run
`pnpm gen && pnpm validate && pnpm test`. Do not edit the vendored files; ChartStays
changes belong in `packages/node-template` or `tools/node-generator`.
