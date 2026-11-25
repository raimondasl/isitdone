// Keeps everything that repeats the package version (or the skill text) in step with its source of truth.
//   node scripts/sync-server-json.mjs           rewrite the followers (after a version bump; the release workflow runs it too)
//   node scripts/sync-server-json.mjs --check   exit 1 when anything disagrees (the test suite runs this)
// Source of truth: package.json "version" and the root SKILL.md. Followers:
//   server.json                      MCP Registry manifest for `isitdone mcp` (server version and the npm package version)
//   alias/package.json               the unscoped `isitdone` alias package (its version, and its exact dependency on this one)
//   .claude-plugin/plugin.json       Claude Code plugin manifest
//   .claude-plugin/marketplace.json  the repo's own plugin marketplace entry
//   hooks/hooks.json                 the plugin's hook commands: node on the plugin's own bundle (a plugin at version X runs
//                                    code X: no npx start-up, no supply-chain drift, no stale npx cache)
//   plugin/isitdone.js               that bundle: the release's dist/isitdone.js (build first), plus plugin/package.json
//   skills/isitdone/SKILL.md         copy of the root SKILL.md, where Claude Code plugin discovery looks for skills
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  // Exact, never a range: with "*", an npx cache entry of alias 0.8.2 was found running @aivolution/isitdone 0.2.1.
  a.dependencies = { ...a.dependencies, [pkg.name]: pkg.version };
});
json('.claude-plugin/plugin.json', (p) => {
  p.version = pkg.version;
});
json('.claude-plugin/marketplace.json', (m) => {
  for (const p of m.plugins ?? []) if (p.name === 'isitdone') p.version = pkg.version;
});
// The plugin's hooks run the plugin's own copy of the bundle with node: npx would add npm's start-up to every stop and
// every edit. Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} into the command text; the quotes keep a path with spaces whole.
const PLUGIN_HOOK = 'node "${CLAUDE_PLUGIN_ROOT}/plugin/isitdone.js" hook --host claude';
json('hooks/hooks.json', (h) => {
  for (const [event, groups] of Object.entries(h.hooks ?? {})) {
    for (const g of groups) for (const hook of g.hooks ?? []) if (typeof hook.command === 'string' && /\bisitdone\b/.test(hook.command)) hook.command = event === 'PostToolUse' ? `${PLUGIN_HOOK} --event edit` : PLUGIN_HOOK;
  }
});

// plugin/isitdone.js is the release's dist/isitdone.js, committed so that the plugin carries it; checked by running it.
// plugin/package.json says it is an ES module (Node before 22.7 does not guess).
const runVersion = (rel) => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(rel, root)), '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return r.status === 0 ? (r.stdout ?? '').trim().split('\n').pop() : null;
};
const blockers = [];
const pluginVersion = runVersion('plugin/isitdone.js');
if (pluginVersion !== pkg.version) {
  problems.push(`plugin/isitdone.js is ${pluginVersion ?? 'missing or broken'}, not ${pkg.version}`);
  if (runVersion('dist/isitdone.js') === pkg.version) writes.push(['plugin/isitdone.js', read('dist/isitdone.js')]);
  else blockers.push(`dist/isitdone.js is not ${pkg.version} either: run npm run build first`);
}
let pluginPkg = null;
try {
  pluginPkg = JSON.parse(read('plugin/package.json'));
} catch {
  // missing
}
if (pluginPkg?.type !== 'module') {
  problems.push('plugin/package.json does not say "type": "module"');
  writes.push(['plugin/package.json', '{\n  "type": "module"\n}\n']);
}

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

if (blockers.length > 0 && !check) {
  console.error(`${problems.join('; ')}; ${blockers.join('; ')}`);
  process.exit(1);
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
