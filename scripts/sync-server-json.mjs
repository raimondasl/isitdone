// Keeps server.json (the MCP Registry manifest for `isitdone mcp`) on the version in package.json.
//   node scripts/sync-server-json.mjs           rewrite server.json (after a version bump; the release workflow runs it too)
//   node scripts/sync-server-json.mjs --check   exit 1 when they disagree (the test suite runs this)
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const file = new URL('server.json', root);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const server = JSON.parse(readFileSync(file, 'utf8'));
const check = process.argv.includes('--check');

// The registry proves npm ownership by reading "mcpName" from the published package: it must be the server's name.
if (pkg.mcpName !== server.name) {
  console.error(`package.json mcpName (${pkg.mcpName}) must equal server.json name (${server.name})`);
  process.exit(1);
}
const own = (server.packages ?? []).filter((p) => p.identifier === pkg.name);
if (own.length === 0) {
  console.error(`server.json lists no package with the identifier ${pkg.name}`);
  process.exit(1);
}

const stale = [server, ...own].filter((entry) => entry.version !== pkg.version);
if (stale.length === 0) {
  console.log(`server.json is in sync with package.json (${pkg.version})`);
} else if (check) {
  console.error(`server.json is on ${stale[0].version}, package.json on ${pkg.version}: run node scripts/sync-server-json.mjs`);
  process.exit(1);
} else {
  for (const entry of stale) entry.version = pkg.version;
  writeFileSync(file, JSON.stringify(server, null, 2) + '\n');
  console.log(`server.json -> ${pkg.version}`);
}
