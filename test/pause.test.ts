import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDecisions, summarizeDecisions, type GateRecord } from '../src/gatelog.js';
import { readState, runHook, writeState } from '../src/hook.js';
import { activePause, clearPause, describePause, formatSpan, isAgentShell, MAX_PAUSE_MS, parseDuration, parseUntil, pauseFiles, pausesDir, writePause } from '../src/pause.js';
import { FAIL, nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
  rmSync(pausesDir() as string, { recursive: true, force: true });
});

const H = 3_600_000;
const DONE = 'Done. All 48 tests pass and the auth refactor is complete.';
const PROGRESS = 'I looked at the parser. Do you want me to also refactor the tokenizer?';
const payload = (root: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 's1', transcript_path: '/x.jsonl', cwd: root, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: DONE, ...extra });
const message = (stdout: string): string | undefined => (stdout === '' ? undefined : (JSON.parse(stdout) as { systemMessage?: string }).systemMessage);

function failingRepo(check = FAIL): TempRepo {
  repo = tempRepo({ files: { 'package.json': nodePkg({ test: check }), '.gitignore': '.isitdone/\n' } });
  return repo;
}

function rawFile(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
}

describe('pause parsing', () => {
  it('reads durations in minutes, hours, days and weeks', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('90min')).toBe(90 * 60_000);
    expect(parseDuration(' 2h ')).toBe(2 * H);
    expect(parseDuration('3d')).toBe(72 * H);
    expect(parseDuration('1W')).toBe(7 * 24 * H);
    for (const bad of ['0h', '2', 'h', '1.5h', '-1d', '2 days', '1mo', '']) expect(parseDuration(bad)).toBeNull();
  });

  it('reads --until: a bare date is the end of that local day, a time without a zone is local, Z or an offset is honoured', () => {
    expect(parseUntil('2026-11-02')).toBe(new Date(2026, 10, 2, 23, 59, 59, 999).getTime());
    expect(parseUntil('2026-11-02T11:00')).toBe(new Date(2026, 10, 2, 11, 0).getTime());
    expect(parseUntil('2026-11-02 11:00')).toBe(new Date(2026, 10, 2, 11, 0).getTime());
    expect(parseUntil('2026-11-02T11:00Z')).toBe(Date.parse('2026-11-02T11:00:00Z'));
    expect(parseUntil('2026-11-02T11:00:00+02:00')).toBe(Date.parse('2026-11-02T09:00:00Z'));
    expect(parseUntil('2028-02-29')).not.toBeNull();
    // V8 would roll these over into the next month; they are refused instead.
    for (const bad of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-11-02T25:00', 'tomorrow', '30d', '11/02/2026', '']) expect(parseUntil(bad)).toBeNull();
  });

  it('spells spans rounded down, never up', () => {
    expect(formatSpan(20_000)).toBe('under a minute');
    expect(formatSpan(45 * 60_000)).toBe('45 min');
    expect(formatSpan(90 * 60_000)).toBe('1 h 30 min');
    expect(formatSpan(3 * H)).toBe('3 h');
    expect(formatSpan(2870 * 60_000)).toBe('1 d 23 h');
    expect(formatSpan(3 * 24 * H)).toBe('3 d');
    expect(formatSpan(13 * 24 * H + 4 * H + 59 * 60_000)).toBe('13 d 4 h');
  });

  it('treats any agent-host marker as an agent shell, even when it is empty', () => {
    expect(isAgentShell({ PATH: '/bin' })).toBe(false);
    for (const v of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CURSOR_AGENT', 'GEMINI_CLI', 'QWEN_CODE']) {
      expect(isAgentShell({ [v]: '1' })).toBe(true);
      expect(isAgentShell({ [v]: '' })).toBe(true);
    }
  });
});

describe('pause files', () => {
  it('live outside every project; a repository pause covers that repository and its worktrees, the user-wide one everything', () => {
    const a = tempRepo({ files: { 'a.txt': 'a' } });
    const b = tempRepo({ files: { 'b.txt': 'b' } });
    const wt = join(mkdtempSync(join(tmpdir(), 'isitdone-wt-')), 'wt');
    try {
      a.git('worktree', 'add', '-q', wt);
      const now = Date.now();
      const p = writePause('repo', a.root, now + H, '9.9.9', now, a.root);
      expect(dirname(p.file)).toBe(join(homedir(), '.isitdone', 'pauses'));
      expect(existsSync(join(a.root, '.isitdone'))).toBe(false);
      expect(activePause(pauseFiles(a.root), now)?.scope).toBe('repo');
      expect(activePause(pauseFiles(join(a.root, 'sub-dir-that-does-not-matter')), now)).toBeNull();
      expect(activePause(pauseFiles(wt), now)?.repo).toBe(a.root);
      expect(activePause(pauseFiles(b.root), now)).toBeNull();
      writePause('global', null, now + 2 * H, '9.9.9', now);
      expect(activePause(pauseFiles(b.root), now)?.scope).toBe('global');
      expect(activePause(pauseFiles(null), now)?.scope).toBe('global');
      // Both apply in a: the one that ends last is in force.
      expect(describePause(activePause(pauseFiles(a.root), now)!, now)).toMatch(/^for every repository of this user until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC.* \(2 h from now\)$/);
      expect(clearPause(pauseFiles(a.root).global, 'global', now)?.scope).toBe('global');
      expect(activePause(pauseFiles(a.root), now)?.scope).toBe('repo');
      expect(clearPause(pauseFiles(wt).repo, 'repo', now)?.scope).toBe('repo');
      expect(activePause(pauseFiles(a.root), now)).toBeNull();
      expect(() => writePause('repo', b.root + '-missing', now + H, '9.9.9')).toThrow(/not inside a git repository/);
    } finally {
      a.cleanup();
      b.cleanup();
      rmSync(dirname(wt), { recursive: true, force: true });
    }
  });

  it('ignores expired, malformed and over-long pauses: when in doubt, the gate runs', () => {
    const r = (repo = tempRepo({ files: { 'a.txt': 'a' } }));
    const now = Date.now();
    const f = writePause('repo', r.root, now + H, '9.9.9', now).file;
    expect(activePause(pauseFiles(r.root), now)).not.toBeNull();
    for (const bad of [{ until: new Date(now - 1000).toISOString() }, '{"until": ', { until: 'next tuesday' }, { until: 12345 }, ['until'], { until: new Date(now + MAX_PAUSE_MS + 60_000).toISOString() }]) {
      rawFile(f, bad);
      expect(activePause(pauseFiles(r.root), now)).toBeNull();
    }
    expect(readdirSync(pausesDir() as string)).toEqual([f.split(/[\\/]/).pop()]);
  });
});

describe('the Stop hook while paused', () => {
  it('lets a failing "done" through without running anything, says so on every claim, and stays quiet on progress stops', async () => {
    const r = failingRepo();
    expect((await runHook({ host: 'claude', stdin: payload(r.root) })).decision).toBe('block');

    writePause('repo', r.root, Date.now() + H, '9.9.9');
    // Cut short a block in progress: always said, with the count.
    const cut = await runHook({ host: 'claude', stdin: payload(r.root, { stop_hook_active: true }) });
    expect(cut).toMatchObject({ decision: 'allow', kind: 'user-paused', result: null, attempts: 1 });
    expect(message(cut.stdout)).toMatch(/^isitdone had blocked this turn 1 time because checks failed; it is paused in this repository until .*let stop with them unfixed\. `npx isitdone resume` turns the gate back on\.$/);
    expect(readState(r.root, 'claude', 's1')?.attempts).toBe(0);

    const claim = await runHook({ host: 'claude', stdin: payload(r.root) });
    expect(message(claim.stdout)).toMatch(/^isitdone is paused in this repository until .*; this stop was not checked\./);
    const progress = await runHook({ host: 'claude', stdin: payload(r.root, { last_assistant_message: PROGRESS }) });
    expect(progress).toMatchObject({ decision: 'allow', kind: 'user-paused', stdout: '' });

    writePause('global', null, Date.now() + 2 * H, '9.9.9');
    expect(message((await runHook({ host: 'claude', stdin: payload(r.root) })).stdout)).toMatch(/^isitdone is paused for every repository of this user .*`npx isitdone resume --global`/);

    const log = readDecisions(r.root);
    expect(log.map((x) => x.kind)).toEqual(['blocked', 'user-paused', 'user-paused', 'user-paused', 'user-paused']);
    expect(log[1]).toMatchObject({ claim: true, profile: null, checks: 0, failed: 0, attempts: 1 });
    expect(log[3]).toMatchObject({ claim: false });

    clearPause(pauseFiles(r.root).global, 'global');
    clearPause(pauseFiles(r.root).repo, 'repo');
    expect((await runHook({ host: 'claude', stdin: payload(r.root) })).decision).toBe('block');
  });

  it('adds nothing to a project the gate never ran in', async () => {
    const r = failingRepo();
    writePause('global', null, Date.now() + H, '9.9.9');
    const o = await runHook({ host: 'claude', stdin: payload(r.root) });
    expect(o.kind).toBe('user-paused');
    expect(existsSync(join(r.root, '.isitdone'))).toBe(false);
  });

  it('a pause that starts while the checks run stops them, and the stop is let through without a receipt', async () => {
    const r = failingRepo('node -e "setTimeout(function(){ process.exit(1) }, 20000)"');
    const started = Date.now();
    const pending = runHook({ host: 'claude', stdin: payload(r.root) });
    setTimeout(() => writePause('repo', r.root, Date.now() + H, '9.9.9'), 1000);
    const o = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(o).toMatchObject({ decision: 'allow', kind: 'user-paused' });
    expect(message(o.stdout)).toMatch(/^isitdone was paused in this repository .* while its checks were running; they were stopped, and this stop was not checked\./);
    expect(existsSync(join(r.root, '.isitdone', 'receipt.json'))).toBe(false);
  }, 30_000);

  it('a pause that comes while the hook waits for another run ends the wait', async () => {
    const r = failingRepo();
    // Another run holds the lock (fresh heartbeat), so this hook would wait for it.
    rawFile(join(r.root, '.isitdone', 'run.lock'), { pid: process.pid, token: 'other', startedAt: Date.now() });
    const started = Date.now();
    const pending = runHook({ host: 'claude', stdin: payload(r.root) });
    setTimeout(() => writePause('global', null, Date.now() + H, '9.9.9'), 1000);
    const o = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(o.kind).toBe('user-paused');
  }, 30_000);

  it('the CLI clears repository pauses that ran out, so the hook stops paying a git call for them', () => {
    const r = (repo = tempRepo({ files: { 'a.txt': 'a' } }));
    const stale = writePause('repo', r.root, Date.now() + H, '9.9.9').file;
    rawFile(stale, { until: new Date(Date.now() - 1000).toISOString() });
    writePause('global', null, Date.now() + H, '9.9.9');
    expect(existsSync(stale)).toBe(false);
  });

  it('a pause in the repository covers a project in a sub-directory', async () => {
    const r = (repo = tempRepo({ files: { 'pkg/package.json': nodePkg({ test: FAIL }), '.gitignore': '.isitdone/\n' } }));
    writePause('repo', r.root, Date.now() + H, '9.9.9');
    expect((await runHook({ host: 'claude', stdin: payload(join(r.root, 'pkg')) })).kind).toBe('user-paused');
  });

  it('doctor mode ignores the pause: the probe must still prove that the hook blocks', async () => {
    const r = failingRepo();
    writePause('global', null, Date.now() + H, '9.9.9');
    expect((await runHook({ host: 'claude', stdin: payload(r.root), doctor: true })).decision).toBe('block');
  });

  it('an expired pause is ignored and the gate blocks as before, with the attempts counted from where they were', async () => {
    const r = failingRepo();
    const f = writePause('global', null, Date.now() + H, '9.9.9').file;
    rawFile(f, { until: new Date(Date.now() - 1000).toISOString() });
    writeState(r.root, { host: 'claude', sessionId: 's1', turnId: null, attempts: 1, loopCount: null, lastTree: null, updatedAt: new Date().toISOString() });
    const o = await runHook({ host: 'claude', stdin: payload(r.root, { stop_hook_active: true }) });
    expect(o.decision).toBe('block');
    expect(o.attempts).toBe(2);
  });
});

describe('history: paused stops', () => {
  it('are counted on their own, not among the claims the gate weighed, and a blocked turn a pause ended is named', () => {
    const rec = (t: string, kind: GateRecord['kind'], claim: boolean | null): GateRecord => ({ t, host: 'claude', session: 'a', kind, claim, profile: null, attempts: 0, checks: 0, failed: 0 });
    const s = summarizeDecisions([[rec('2026-10-01T00:00:00Z', 'blocked', true), rec('2026-10-01T00:01:00Z', 'user-paused', true), rec('2026-10-01T00:02:00Z', 'user-paused', false), rec('2026-10-01T00:03:00Z', 'passed', true)]]);
    expect(s).toMatchObject({ pausedStops: 2, pausedTurns: 1, claims: 2, claimsBlocked: 1, checked: 2, blockedTurns: 1, other: 0 });
  });
});
