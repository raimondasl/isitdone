/**
 * docs/agent-hooks.json is the machine-readable half of docs/agent-hooks.md, a vendor-neutral reference other tools and
 * agents consume. These tests pin it to the adapters in src/hosts.ts so the reference cannot drift from the code: a host
 * that is added, renamed, moved to another settings file or given another block shape fails here until the docs follow.
 * The reference may know MORE than the adapters (a post-edit channel isitdone does not use yet), never something else.
 */
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOST_NAMES, HOSTS, hostScopes, type HostAdapter, type HostName } from '../src/hosts.js';

interface PostEdit {
  event: string;
  matcher: string;
  channel: string;
}

interface AgentEntry {
  id: string;
  agent: string;
  kind: 'command-hook' | 'plugin';
  projectConfig: string;
  userConfig: string;
  userConfigWindows?: string;
  scopes: string[];
  configShape: string;
  event: string;
  canBlock: 'veto' | 'follow-up';
  blockVia: string[];
  blockOutput: Record<string, unknown> | null;
  allowOutput: string | null;
  finalMessage: boolean;
  finalMessageField: string | null;
  continuationFlag: string | null;
  hostBlockCap: number | null;
  timeoutField: string | null;
  timeoutUnit: 's' | 'ms' | null;
  timeoutDefault: number | null;
  timeoutLegacyMsFrom?: number;
  failOpen: boolean;
  postEdit: PostEdit | null;
  alsoLoads: string[];
  docs: string;
  unverified: string[];
}

interface Reference {
  title: string;
  checked: string;
  fields: Record<string, string>;
  agents: AgentEntry[];
}

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const ref = JSON.parse(readFileSync(join(DOCS, 'agent-hooks.json'), 'utf8')) as Reference;
const md = readFileSync(join(DOCS, 'agent-hooks.md'), 'utf8');
const byId = new Map(ref.agents.map((a) => [a.id, a]));
const entry = (name: HostName): AgentEntry => {
  const a = byId.get(name);
  if (!a) throw new Error(`docs/agent-hooks.json has no entry for host "${name}"`);
  return a;
};

/** One value per host, keyed by host name, so a mismatch shows up in the diff under the host it belongs to. */
const perHost = <T>(f: (a: AgentEntry, h: HostAdapter) => T, names: HostName[] = HOST_NAMES): Record<string, T> => Object.fromEntries(names.map((n) => [n, f(entry(n), HOSTS[n])]));

/** Never created: settingsPath() only joins strings. */
const ROOT = join(tmpdir(), 'agent-hooks-doc-root');
const slash = (p: string) => p.replace(/\\/g, '/');
/** `<name>` in the reference is a file or directory the reader picks; isitdone picks "isitdone". */
const named = (p: string) => p.replace('<name>', 'isitdone');
const REASON = '<reason>';
const DONE = 'Done. All tests pass.';
const JSON_HOSTS = HOST_NAMES.filter((n) => HOSTS[n].kind === 'json');
const FILE_HOSTS = HOST_NAMES.filter((n) => HOSTS[n].kind === 'file');

describe('docs/agent-hooks.json matches the host adapters', () => {
  it('has exactly one entry per HOST_NAMES host, in the same order', () => {
    expect(ref.agents.map((a) => a.id)).toEqual(HOST_NAMES);
  });

  it('uses the event name the adapter registers', () => {
    expect(perHost((a) => a.event)).toEqual(perHost((_a, h) => h.event));
  });

  it('names the project and user settings paths the adapter writes, and the scopes it supports', () => {
    expect(perHost((a) => named(a.projectConfig))).toEqual(perHost((_a, h) => slash(relative(ROOT, h.settingsPath(ROOT, 'project')))));
    // test/setup.ts points HOME, %APPDATA% and the XDG/COPILOT variables at one throwaway home, so "~" is homedir().
    const documented = (a: AgentEntry) => (process.platform === 'win32' && a.userConfigWindows ? a.userConfigWindows.replace('%APPDATA%', '~/AppData/Roaming') : a.userConfig);
    expect(perHost((a) => named(documented(a)))).toEqual(perHost((_a, h) => '~/' + slash(relative(homedir(), h.settingsPath(ROOT, 'user')))));
    expect(perHost((a) => a.scopes)).toEqual(perHost((_a, h) => hostScopes(h)));
  });

  it('documents the exact stdout the adapter prints to block and to allow', () => {
    expect(perHost((a) => a.blockOutput, JSON_HOSTS)).toEqual(perHost((_a, h) => JSON.parse(h.block(REASON)) as unknown, JSON_HOSTS));
    expect(perHost((a) => a.allowOutput, JSON_HOSTS)).toEqual(perHost((_a, h) => h.allow(), JSON_HOSTS));
    expect(perHost((a) => a.kind)).toEqual(perHost((_a, h) => (h.kind === 'file' ? 'plugin' : 'command-hook')));
    // A veto is always available as stdout JSON; a follow-up host says so.
    expect(perHost((a) => a.blockVia.includes(a.canBlock === 'veto' ? 'stdout-json' : 'followup-message'), JSON_HOSTS)).toEqual(perHost(() => true, JSON_HOSTS));
    // A plugin shim has no stdout protocol of the host's own; the adapter's block/allow there is isitdone-internal.
    expect(perHost((a) => [a.blockOutput, a.allowOutput], FILE_HOSTS)).toEqual(perHost(() => [null, null], FILE_HOSTS));
  });

  it('agrees on the final message and the continuation flag', () => {
    const parsed = (h: HostAdapter) => h.parse(h.synthetic(ROOT, DONE));
    // One direction each: an adapter may tolerate a message field the vendor does not document (Cursor), but it must
    // not miss one the reference says is there, nor find one where the reference says there is none to find.
    const withMessage = HOST_NAMES.filter((n) => entry(n).finalMessage);
    expect(perHost((_a, h) => parsed(h).lastMessage, withMessage)).toEqual(perHost(() => DONE, withMessage));
    const adapterBlind = HOST_NAMES.filter((n) => parsed(HOSTS[n]).lastMessage === null);
    expect(perHost((a) => a.finalMessage, adapterBlind)).toEqual(perHost(() => false, adapterBlind));
    expect(perHost((a) => a.finalMessageField !== null, JSON_HOSTS)).toEqual(perHost((a) => a.finalMessage, JSON_HOSTS));
    // null in the adapter = the host has no flag at all and isitdone counts its own blocks.
    expect(perHost((a) => a.continuationFlag === null, JSON_HOSTS)).toEqual(perHost((_a, h) => parsed(h).stopHookActive === null, JSON_HOSTS));
  });

  it('agrees on the timeout unit', () => {
    expect(perHost((a) => a.timeoutUnit === 's' || a.timeoutUnit === 'ms', JSON_HOSTS)).toEqual(perHost(() => true, JSON_HOSTS));
    // Milliseconds in the reference mean the adapter must multiply ...
    const msDocumented = HOST_NAMES.filter((n) => entry(n).timeoutUnit === 'ms');
    expect(perHost((_a, h) => h.msTimeouts === true, msDocumented)).toEqual(perHost(() => true, msDocumented));
    // ... and an adapter that multiplies needs the reference to say milliseconds, or to document that large values are
    // read as milliseconds (Qwen Code moved to seconds but still reads >= 1000 as ms).
    const msWritten = HOST_NAMES.filter((n) => HOSTS[n].msTimeouts === true);
    expect(perHost((a) => a.timeoutUnit === 'ms' || typeof a.timeoutLegacyMsFrom === 'number', msWritten)).toEqual(perHost(() => true, msWritten));
  });

  it('lists a post-edit channel for every host isitdone installs an edit hook on, with the same event and matcher', () => {
    const withEdit = HOST_NAMES.filter((n) => HOSTS[n].edit !== null);
    expect(perHost((a) => [a.postEdit?.event, a.postEdit?.matcher], withEdit)).toEqual(perHost((_a, h) => [h.edit?.event, h.edit?.matcher], withEdit));
  });

  it('describes every field it uses and cites a vendor page per agent', () => {
    const described = new Set(Object.keys(ref.fields).flatMap((k) => k.split('/').map((s) => s.trim())));
    expect(perHost((a) => Object.keys(a).filter((k) => !described.has(k)))).toEqual(perHost(() => []));
    expect(perHost((a) => /^https:\/\//.test(a.docs) && Array.isArray(a.unverified))).toEqual(perHost(() => true));
  });
});

describe('docs/agent-hooks.md and docs/agent-hooks.json say the same', () => {
  it('has a section, the config path, the event and the vendor URL for every agent', () => {
    const lines = md.split('\n');
    // "Devin (CLI and Local)" is headed "## Devin (CLI and Local): ..."; the part before the bracket is enough.
    const missing = (a: AgentEntry) =>
      [
        lines.some((l) => l.startsWith('## ' + a.agent.replace(/ \(.*\)$/, ''))) ? null : 'section heading',
        md.includes(a.projectConfig) ? null : a.projectConfig,
        md.includes(a.userConfig) ? null : a.userConfig,
        md.includes('`' + a.event + '`') ? null : a.event,
        md.includes(a.docs) ? null : a.docs,
      ].filter((x) => x !== null);
    expect(perHost(missing)).toEqual(perHost(() => []));
  });

  it('carries the same check date in every section', () => {
    expect(ref.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dates = [...md.matchAll(/^Checked: (\d{4}-\d{2}-\d{2})\./gm)].map((m) => m[1]);
    // one per agent plus the "agents without a gate" section
    expect(dates).toHaveLength(ref.agents.length + 1);
    expect([...new Set(dates)]).toEqual([ref.checked]);
  });
});
