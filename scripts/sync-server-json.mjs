// Keeps everything that repeats the package version (or the skill text) in step with its source of truth.
//   node scripts/sync-server-json.mjs           rewrite the followers (after a version bump; the release workflow runs it too)
//   node scripts/sync-server-json.mjs --check   exit 1 when anything disagrees (the test suite runs this)
// Source of truth: package.json "version" and the root SKILL.md. Followers:
//   server.json                      MCP Registry manifest for `isitdone mcp` (server version and the npm package version)
//   alias/package.json               the unscoped `isitdone` alias package
//   .claude-plugin/plugin.json       Claude Code plugin manifest
//   .claude-plugin/marketplace.json  the repo's own plugin marketplace entry
//   hooks/hooks.json                 the plugin's hook commands, pinned to this exact npm version (a plugin at version X runs
//                                    package X: no supply-chain drift, no stale npx cache)
//   skills/isitdone/SKILL.md         copy of the root SKILL.md, where Claude Code plugin discovery looks for skills
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const pkg = JSON.parse(read('package.json'));
const check = process.argv.includes('--check');
const problems = [];
const writes = [];

function json(rel, mutate) {
  const before = read(rel);
  const data = JSON.parse(before);
  mutate(data);
  const after = JSON.stringify(data, null, 2) + '\n';
  if (after !== before.replace(/\r\n/g, '\n')) {
    problems.push(`${rel} is not on ${pkg.version}`);
    writes.push([rel, after]);
  }
}

// The registry proves npm ownership by reading "mcpName" from the published package: it must be the server's name.
const server = JSON.parse(read('server.json'));
if (pkg.mcpName !== server.name) {
  console.error(`package.json mcpName (${pkg.mcpName}) must equal server.json name (${server.name})`);
  process.exit(1);
}
if (!(server.packages ?? []).some((p) => p.identifier === pkg.name)) {
  console.error(`server.json lists no package with the identifier ${pkg.name}`);
  process.exit(1);
}

json('server.json', (s) => {
  s.version = pkg.version;
  for (const p of s.packages ?? []) if (p.identifier === pkg.name) p.version = pkg.version;
});
json('alias/package.json', (a) => {
  a.version = pkg.version;
});
json('.claude-plugin/plugin.json', (p) => {
  p.version = pkg.version;
});
json('.claude-plugin/marketplace.json', (m) => {
  for (const p of m.plugins ?? []) if (p.name === 'isitdone') p.version = pkg.version;
});
json('hooks/hooks.json', (h) => {
  const pin = (cmd) => cmd.replace(new RegExp(`${pkg.name.replace('/', '\\/')}(?:@[^\\s"]+)?(?=\\s)`), `${pkg.name}@${pkg.version}`);
  for (const groups of Object.values(h.hooks ?? {})) for (const g of groups) for (const hook of g.hooks ?? []) if (typeof hook.command === 'string') hook.command = pin(hook.command);
});

const skill = read('SKILL.md');
let skillCopy = null;
try {
  skillCopy = read('skills/isitdone/SKILL.md');
} catch {
  // not there yet
}
if (skillCopy === null || skillCopy.replace(/\r\n/g, '\n') !== skill.replace(/\r\n/g, '\n')) {
  problems.push('skills/isitdone/SKILL.md differs from the root SKILL.md');
  writes.push(['skills/isitdone/SKILL.md', skill]);
}

if (problems.length === 0) {
  console.log(`everything is in sync with package.json (${pkg.version})`);
} else if (check) {
  console.error(`${problems.join('; ')}: run node scripts/sync-server-json.mjs`);
  process.exit(1);
} else {
  for (const [rel, text] of writes) {
    mkdirSync(new URL('./', new URL(rel, root)), { recursive: true });
    writeFileSync(new URL(rel, root), text);
  }
  console.log(`synced to ${pkg.version}: ${writes.map(([rel]) => rel).join(', ')}`);
}
