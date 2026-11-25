import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDecisions, summarizeDecisions, type GateRecord } from '../src/gatelog.js';
import { runHook } from '../src/hook.js';
import { pluginHooks } from '../src/init.js';
import { directCommand, installLocalCopy, localCopyPath, runsLocalCopy } from '../src/localcopy.js';
import { addCutOffNotice, collectCutOffs, RUNS_DIR, startRunMark, takeCutOffNotice } from '../src/runmarks.js';
import { FAIL, nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
const scratch: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(join(homedir(), '.isitdone'), { recursive: true, force: true });
  rmSync(join(homedir(), '.claude'), { recursive: true, force: true });
});

/** A stand-in bundle that answers --version like the real one. */
function fakeBundle(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'isitdone-bundle-'));
  scratch.push(dir);
  const file = join(dir, 'isitdone.js');
  writeFileSync(file, `console.log(${JSON.stringify(version)})\n`);
  return file;
}

describe('the local copy hooks run with node', () => {
  it('is installed once, never downgraded, and moved up by a newer release', () => {
    const path = localCopyPath() as string;
    expect(path).toBe(join(homedir(), '.isitdone', 'bin', 'isitdone.js'));
    expect(installLocalCopy(fakeBundle('1.2.0'), '1.2.0')).toMatchObject({ action: 'installed', version: '1.2.0', path });
    expect(installLocalCopy(fakeBundle('1.2.0'), '1.2.0')).toMatchObject({ action: 'unchanged', version: '1.2.0' });
    expect(installLocalCopy(fakeBundle('1.1.9'), '1.1.9')).toMatchObject({ action: 'unchanged', version: '1.2.0' });
    expect(readFileSync(path, 'utf8')).toContain('1.2.0');
    expect(installLocalCopy(fakeBundle('1.3.0'), '1.3.0')).toMatchObject({ action: 'updated', version: '1.3.0' });
    expect(installLocalCopy(null)).toMatchObject({ action: 'unavailable' });
  });

  it('is replaced only by a copy that has already answered, and says it is an ES module', () => {
    const path = localCopyPath() as string;
    expect(installLocalCopy(fakeBundle('1.2.0'), '1.2.0').action).toBe('installed');
    expect(JSON.parse(readFileSync(join(homedir(), '.isitdone', 'bin', 'package.json'), 'utf8'))).toEqual({ type: 'module' });
    // A "1.3.0" that does not run (or answers with something else) never reaches the path the hooks run.
    const broken = fakeBundle('1.3.0');
    writeFileSync(broken, 'throw new Error("needs a newer node")\n');
    expect(installLocalCopy(broken, '1.3.0')).toMatchObject({ action: 'unavailable', version: '1.2.0' });
    expect(installLocalCopy(fakeBundle('1.2.9'), '1.3.0')).toMatchObject({ action: 'unavailable', version: '1.2.0' });
    expect(readFileSync(path, 'utf8')).toContain('1.2.0');
    expect(readdirSync(join(homedir(), '.isitdone', 'bin')).sort()).toEqual(['isitdone.js', 'package.json']);
  });

  it('is registered as a plain node command that every shell runs, and recognised as such', () => {
    const cmd = directCommand('C:\\Users\\me\\.isitdone\\bin\\isitdone.js', 'claude');
    expect(cmd).toBe('node "C:/Users/me/.isitdone/bin/isitdone.js" hook --host claude');
    expect(runsLocalCopy(directCommand(localCopyPath() as string, 'claude'))).toBe(true);
    expect(runsLocalCopy('npx -y @aivolution/isitdone hook --host claude')).toBe(false);
  });
});

describe('plugin hooks', () => {
  it('finds isitdone in a plugin kept under ~/.claude/skills and in installed plugins, with their timeouts', () => {
    const skill = join(homedir(), '.claude', 'skills', 'isitdone', 'hooks');
    mkdirSync(skill, { recursive: true });
    mkdirSync(join(homedir(), '.claude', 'skills', 'isitdone', '.claude-plugin'));
    writeFileSync(join(homedir(), '.claude', 'skills', 'isitdone', '.claude-plugin', 'plugin.json'), '{"name":"isitdone"}');
    writeFileSync(join(skill, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "x/isitdone.js" hook --host claude', timeout: 2400 }] }], PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'node "x/isitdone.js" hook --host claude --event edit', timeout: 30 }] }] } }));
    const installed = mkdtempSync(join(tmpdir(), 'isitdone-plugin-'));
    scratch.push(installed);
    mkdirSync(join(installed, 'hooks'));
    writeFileSync(join(installed, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npx -y @aivolution/isitdone@0.8.2 hook --host claude', timeout: 600 }] }] } }));
    mkdirSync(join(homedir(), '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'isitdone@isitdone': [{ scope: 'user', installPath: installed }] } }));
    // An unrelated skill without hooks is ignored, and so is a hooks.json in a skill that is not a plugin.
    mkdirSync(join(homedir(), '.claude', 'skills', 'other'), { recursive: true });
    mkdirSync(join(homedir(), '.claude', 'skills', 'not-a-plugin', 'hooks'), { recursive: true });
    writeFileSync(join(homedir(), '.claude', 'skills', 'not-a-plugin', 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npx isitdone hook --host claude' }] }] } }));
    const found = pluginHooks();
    expect(found.map((h) => [h.event, h.scope, h.timeout])).toEqual([
      ['stop', 'plugin', 2400],
      ['edit', 'plugin', 30],
      ['stop', 'plugin', 600],
    ]);

    // Installed for another project only, or switched off: it does not run here, so it does not count.
    const here = mkdtempSync(join(tmpdir(), 'isitdone-here-'));
    scratch.push(here);
    writeFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'isitdone@isitdone': [{ scope: 'project', projectPath: join(tmpdir(), 'elsewhere'), installPath: installed }] } }));
    expect(pluginHooks(here).filter((h) => h.path.startsWith(installed))).toEqual([]);
    writeFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'isitdone@isitdone': [{ scope: 'project', projectPath: here, installPath: installed }] } }));
    expect(pluginHooks(join(here, 'sub')).filter((h) => h.path.startsWith(installed))).toHaveLength(1);
    writeFileSync(join(homedir(), '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'isitdone@isitdone': false } }));
    expect(pluginHooks(here).filter((h) => h.path.startsWith(installed))).toEqual([]);
  });
});

describe('check runs the host cut off', () => {
  it('a run that ends removes its marker; a marker that went stale is collected once', () => {
    const r = (repo = tempRepo({ files: { 'a.txt': 'a' } }));
    const end = startRunMark(r.root, { host: 'claude', session: 'claude-abc', profile: 'full' });
    const dir = join(r.root, '.isitdone', RUNS_DIR);
    expect(existsSync(join(dir, `claude-abc-${process.pid}.json`))).toBe(true);
    expect(collectCutOffs(r.root)).toEqual([]);
    end();
    expect(existsSync(join(dir, `claude-abc-${process.pid}.json`))).toBe(false);

    const started = Date.now() - 30 * 60_000;
    const stale = join(dir, 'claude-def-999999.json');
    writeFileSync(stale, JSON.stringify({ pid: 999999, host: 'claude', session: 'claude-def', profile: 'full', startedAt: new Date(started).toISOString() }));
    const lastBeat = new Date(started + 28 * 60_000);
    utimesSync(stale, lastBeat, lastBeat);
    const fresh = join(dir, 'claude-ghi-999998.json');
    writeFileSync(fresh, JSON.stringify({ pid: 999998, host: 'claude', session: 'claude-ghi', profile: 'full', startedAt: new Date().toISOString() }));
    const cut = collectCutOffs(r.root);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ session: 'claude-def', profile: 'full' });
    expect(Math.round(cut[0]!.ranMs / 60_000)).toBe(28);
    expect(collectCutOffs(r.root)).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it('the next stop logs it and tells the user', async () => {
    const r = (repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), '.gitignore': '.isitdone/\n' } }));
    const dir = join(r.root, '.isitdone', RUNS_DIR);
    mkdirSync(dir, { recursive: true });
    const started = Date.now() - 41 * 60_000;
    const stale = join(dir, 'claude-old-999997.json');
    writeFileSync(stale, JSON.stringify({ pid: 999997, host: 'claude', session: 'claude-old', profile: 'full', startedAt: new Date(started).toISOString() }));
    const beat = new Date(started + 40 * 60_000);
    utimesSync(stale, beat, beat);
    const o = await runHook({ host: 'claude', stdin: JSON.stringify({ session_id: 's1', cwd: r.root, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done, all tests pass.' }) });
    expect(o.decision).toBe('block');
    expect(JSON.parse(o.stdout).reason).toMatch(/a check run here stopped answering after 40 min without finishing, cut off by the host \(its hook timeout, or an interrupted turn\): nothing was verified/);
    expect(readDecisions(r.root).map((x) => x.kind)).toEqual(['cut-off', 'blocked']);
    // This stop's own run ended and left no marker behind.
    expect(collectCutOffs(r.root, Date.now() + 10 * 60_000)).toEqual([]);
  });

  it('the notice waits for a stop that can show it, and is shown once', () => {
    const r = (repo = tempRepo({ files: { 'a.txt': 'a' } }));
    const cut = (min: number) => ({ pid: 1, host: 'claude', session: 's', profile: 'full' as const, startedAt: new Date().toISOString(), ranMs: min * 60_000 });
    addCutOffNotice(r.root, [cut(40)]);
    addCutOffNotice(r.root, [cut(12), cut(41)]);
    expect(takeCutOffNotice(r.root)).toEqual({ count: 3, longestMs: 41 * 60_000 });
    expect(takeCutOffNotice(r.root)).toBeNull();
  });

  it('history counts them, and a blocked turn they ended', () => {
    const rec = (t: string, kind: GateRecord['kind']): GateRecord => ({ t, host: 'claude', session: 'a', kind, claim: null, profile: 'full', attempts: 0, checks: 0, failed: 0 });
    const s = summarizeDecisions([[rec('2026-11-01T00:00:00Z', 'blocked'), rec('2026-11-01T00:01:00Z', 'cut-off'), rec('2026-11-01T01:00:00Z', 'cut-off')]]);
    expect(s).toMatchObject({ cutOff: 2, cutOffTurns: 1, blockedTurns: 1, checked: 1, other: 0 });
  });
});
