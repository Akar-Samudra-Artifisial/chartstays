// The TEST-ONLY interop fixture nodes (tools/e2e/interop-fixtures.mjs, docs/interop-s6.md) must
// never reach the default node config or public/directory.json. pnpm validate (check 6) uses
// testNodeLeaks() on both files. Keep FIXTURE_PORT_MIN/MAX in step with FIXTURE_PORTS there.

export const FIXTURE_PORT_MIN = 4106;
export const FIXTURE_PORT_MAX = 4111;
export const FIXTURE_NETWORK_PREFIX = "fixture_";

export interface ListedNode {
  origin: string;
  network: string;
  test?: unknown;
}

function fixturePort(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const port = Number(url.port);
  return port >= FIXTURE_PORT_MIN && port <= FIXTURE_PORT_MAX;
}

/** One message per listed node that is (or looks like) a test fixture node; empty when none. */
export function testNodeLeaks(source: string, config: { test?: unknown; nodes: readonly ListedNode[] }): string[] {
  const problems: string[] = [];
  if (config.test !== undefined) problems.push(`${source}: is marked "test"; test configs are only written by the e2e into a temporary folder`);
  for (const node of config.nodes) {
    const reasons: string[] = [];
    if (node.test !== undefined) reasons.push('marked "test"');
    if (node.network.startsWith(FIXTURE_NETWORK_PREFIX)) reasons.push(`network ${node.network}`);
    if (fixturePort(node.origin)) reasons.push(`fixture port ${FIXTURE_PORT_MIN}-${FIXTURE_PORT_MAX}`);
    if (reasons.length > 0) problems.push(`${source}: lists the test fixture node ${node.origin} (${reasons.join(", ")}); fixtures belong only in tools/e2e/interop-fixtures.mjs`);
  }
  return problems;
}
