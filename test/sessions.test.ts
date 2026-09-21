import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dirtyPathSet } from '../src/git.js';
import { readState, runEditHook, runHook } from '../src/hook.js';
import { ACTIVE_WINDOW_MS, acquireRunLock, attribute, liveSessionsNote, mentions, readSessions, recordEdits } from '../src/sessions.js';
import { FAIL, nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const DONE = 'Done. All tests pass and the refactor is complete.';
/** A "test suite" that fails for every source file containing BROKEN and names it the way a real tool would. */
const CHECK = `const fs = require('fs');
let bad = 0;
for (const f of ['src/a.js', 'src/b.js']) {
  if (fs.readFileSync(f, 'utf8').includes('BROKEN')) { console.log(f + ':1: error: broken'); bad++; }
}
console.log(bad + ' failed, ' + (2 - bad) + ' passed');
process.exit(bad ? 1 : 0);
`;

function twoFileRepo(extra: Record<string, string> = {}): TempRepo {
  return tempRepo({ files: { 'package.json': nodePkg({ test: 'node check.js' }), 'check.js': CHECK, 'src/a.js': 'ok\n', 'src/b.js': 'ok\n', ...extra } });
}
function stop(root: string, session: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ session_id: session, transcript_path: '/x.jsonl', cwd: root, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: DONE, ...extra });
}
/** The session edits a file: the file changes and the post-edit hook fires, as it would in the host. */
function edit(r: TempRepo, session: string, file: string, content: string) {
  r.write(file, content);
  runEditHook({ host: 'claude', stdin: JSON.stringify({ session_id: session, cwd: r.root, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(r.root, file), old_string: 'a', new_string: 'b' } }) });
}

describe('edit records and attribution', () => {
  it('sorts uncommitted files into mine, another live session\'s, and shared', () => {
    repo = twoFileRepo({ 'src/c.js': 'ok\n' });
    edit(repo, 's1', 'src/a.js', 'mine\n');
    edit(repo, 's2', 'src/b.js', 'theirs\n');
    edit(repo, 's1', 'src/c.js', 'mine\n');
    edit(repo, 's2', 'src/c.js', 'both\n');
    const a = attribute(repo.root, 'claude', 's1', dirtyPathSet(repo.root));
    expect([...a.mine].sort()).toEqual(['src/a.js', 'src/c.js']);
    expect(a.foreign.map((f) => f.path)).toEqual(['src/b.js']);
    expect(a.shared.map((f) => f.path)).toEqual(['src/c.js']);
    expect(a.otherLastActive).not.toBeNull();
    // Seen from the other side the roles swap.
    expect(attribute(repo.root, 'claude', 's2', dirtyPathSet(repo.root)).foreign.map((f) => f.path)).toEqual(['src/a.js']);
  });

  it('counts only positive, recent evidence: committed files, quiet sessions and id-less payloads prove nothing', () => {
    repo = twoFileRepo();
    edit(repo, 's2', 'src/b.js', 'theirs\n');
    repo.commit('their work landed');
    expect(attribute(repo.root, 'claude', 's1', dirtyPathSet(repo.root)).foreign).toEqual([]);

    repo.write('src/a.js', 'old leftovers\n');
    recordEdits(repo.root, 'claude', 's3', ['src/a.js'], Date.now() - ACTIVE_WINDOW_MS - 60_000);
    expect(attribute(repo.root, 'claude', 's1', dirtyPathSet(repo.root)).foreign).toEqual([]);

    const before = readSessions(repo.root).length;
    recordEdits(repo.root, 'claude', null, ['src/a.js']);
    expect(readSessions(repo.root)).toHaveLength(before);
  });

  it('records edits even when the integrity scan is off, and never records paths outside the repository', () => {
    repo = twoFileRepo({ '.isitdone.json': JSON.stringify({ integrity: 'off' }) });
    edit(repo, 's2', 'src/b.js', 'theirs\n');
    runEditHook({ host: 'claude', stdin: JSON.stringify({ session_id: 's2', cwd: repo.root, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(repo.root, '..', 'elsewhere.txt') } }) });
    const s = readSessions(repo.root).find((x) => x.files.size > 0);
    expect([...(s?.files.keys() ?? [])]).toEqual(['src/b.js']);
  });

  it('the CLI note names who edited what once two live sessions have uncommitted edits, and stays quiet for one', () => {
    repo = twoFileRepo();
    edit(repo, 's1', 'src/a.js', 'mine\n');
    expect(liveSessionsNote(repo.root, dirtyPathSet(repo.root))).toBeNull();
    edit(repo, 's2', 'src/b.js', 'theirs\n');
    const note = liveSessionsNote(repo.root, dirtyPathSet(repo.root)) ?? '';
    expect(note).toMatch(/2 agent sessions have uncommitted edits/);
    expect(note).toMatch(/claude-[0-9a-f]{6} \(active \d+ s ago\): src\/a\.js/);
    expect(note).toMatch(/claude-[0-9a-f]{6} \(active \d+ s ago\): src\/b\.js/);
  });

  it('dirtyPathSet lists modified, untracked, renamed (both sides) and oddly named files', () => {
    repo = twoFileRepo({ 'src/old name.js': 'x\n' });
    repo.write('src/a.js', 'changed\n');
    repo.write('src/new.js', 'new\n');
    repo.git('mv', 'src/old name.js', 'src/renamed.js');
    expect([...dirtyPathSet(repo.root)].sort()).toEqual(['src/a.js', 'src/new.js', 'src/old name.js', 'src/renamed.js']);
  });
});

describe('mentions', () => {
  it('finds a path as tools print it, and only as a whole path', () => {
    expect(mentions('src/reporadar/scan.py:12: error: Incompatible types', 'src/reporadar/scan.py')).toBe(true);
    expect(mentions('FAILED tests/test_scan.py::test_x - assert 1 == 2', 'tests/test_scan.py')).toBe(true);
    expect(mentions(String.raw`C:\repo\src\a.ts(3,5): error TS2322`.replace(/\\/g, '/'), 'src/a.ts')).toBe(true);
    expect(mentions('src/a.tsx(3,5): error', 'src/a.ts')).toBe(false);
    expect(mentions('lib/src/a.ts-backup', 'src/a.ts')).toBe(false);
    expect(mentions('xsrc/a.ts:1', 'src/a.ts')).toBe(false);
  });
  it('accepts the path relative to the project root, and a bare Name.ext:line only for distinctive names', () => {
    expect(mentions(' FAIL  test/api.test.ts > works', 'packages/app/test/api.test.ts', 'packages/app/')).toBe(true);
    expect(mentions(' FAIL  test/api.test.ts > works', 'packages/app/test/api.test.ts')).toBe(false);
    expect(mentions('    scanner_test.go:41: got 3, want 4', 'internal/scan/scanner_test.go')).toBe(true);
    expect(mentions('\tat com.x.ScannerTest.finds(ScannerTest.java:17)', 'src/test/java/com/x/ScannerTest.java')).toBe(true);
    expect(mentions('    utils.py:3: in helper', 'src/pkg/utils.py')).toBe(false);
    expect(mentions('see scanner_test.go for details', 'internal/scan/scanner_test.go')).toBe(false);
  });
});

describe('Stop hook with another session in the same working tree', () => {
  it('does not block a session for failures that only name the other session\'s files', async () => {
    repo = twoFileRepo();
    edit(repo, 's1', 'src/a.js', 'fine\n');
    edit(repo, 's2', 'src/b.js', 'BROKEN\n');
    const o = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(o.decision).toBe('allow');
    expect(o.why).toMatch(/only in files another session is editing/);
    expect(o.stdout).toMatch(/src\/b\.js/);
    expect(o.stdout).toMatch(/was not blocked/);
    expect(readState(repo.root, 'claude', 's1')?.attempts).toBe(0);
    // The tree is still not verified: the receipt says so.
    expect(JSON.parse(readFileSync(join(repo.root, '.isitdone', 'receipt.json'), 'utf8')).status).toBe('FAIL');
    // The session that broke it is held to it, and is told to keep off the first session's file.
    const other = await runHook({ host: 'claude', stdin: stop(repo.root, 's2') });
    expect(other.decision).toBe('block');
    const reason = (JSON.parse(other.stdout) as { reason: string }).reason;
    expect(reason).toMatch(/attempt 1\/3/);
    expect(reason).toMatch(/ANOTHER AGENT SESSION IS WORKING IN THIS SAME DIRECTORY/);
    expect(reason).toMatch(/src\/a\.js {2}\(edited \d+ s ago\)/);
  });

  it('blocks as usual when the failure names this session\'s files, and says which files to leave alone', async () => {
    repo = twoFileRepo();
    edit(repo, 's1', 'src/a.js', 'BROKEN\n');
    edit(repo, 's2', 'src/b.js', 'BROKEN\n');
    const o = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(o.decision).toBe('block');
    const reason = (JSON.parse(o.stdout) as { reason: string }).reason;
    expect(reason).toMatch(/attempt 1\/3/);
    expect(reason).toMatch(/not yours:\n {2}src\/b\.js/);
    expect(reason).not.toMatch(/ {2}src\/a\.js {2}\(edited/);
    expect(reason).toMatch(/Do not edit, revert or "fix" them/);
    expect(reason).toMatch(/Fix only the failures your own changes caused/);
    expect(reason.indexOf('ANOTHER AGENT SESSION')).toBeLessThan(reason.indexOf('npm test'));
  });

  it('blocks once, not three times, when it cannot tell whose change broke the check', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), 'src/a.js': 'ok\n', 'src/b.js': 'ok\n' } });
    edit(repo, 's1', 'src/a.js', 'mine\n');
    edit(repo, 's2', 'src/b.js', 'theirs\n');
    const first = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(first.decision).toBe('block');
    expect((JSON.parse(first.stdout) as { reason: string }).reason).toMatch(/attempt 1\/1/);
    expect(readState(repo.root, 'claude', 's1')?.cap).toBe(1);
    const second = await runHook({ host: 'claude', stdin: stop(repo.root, 's1', { stop_hook_active: true }) });
    expect(second.decision).toBe('allow');
    expect(second.result).toBeNull(); // released without another run
    expect(second.stdout).toMatch(/blocks only once/);
  });

  it('a session that fixed its own files is released even though the other session\'s still fail', async () => {
    repo = twoFileRepo();
    edit(repo, 's1', 'src/a.js', 'BROKEN\n');
    edit(repo, 's2', 'src/b.js', 'BROKEN\n');
    expect((await runHook({ host: 'claude', stdin: stop(repo.root, 's1') })).decision).toBe('block');
    edit(repo, 's1', 'src/a.js', 'fixed\n');
    const o = await runHook({ host: 'claude', stdin: stop(repo.root, 's1', { stop_hook_active: true }) });
    expect(o.decision).toBe('allow');
    expect(o.why).toMatch(/only in files another session is editing/);
  });

  it('changes nothing without a live other session, or with "otherSessions": "ignore"', async () => {
    repo = twoFileRepo();
    repo.write('src/b.js', 'BROKEN\n');
    recordEdits(repo.root, 'claude', 's2', ['src/b.js'], Date.now() - ACTIVE_WINDOW_MS - 60_000);
    const quiet = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(quiet.decision).toBe('block');
    expect((JSON.parse(quiet.stdout) as { reason: string }).reason).not.toMatch(/ANOTHER AGENT SESSION/);

    edit(repo, 's2', 'src/b.js', 'BROKEN again\n');
    repo.write('.isitdone.json', JSON.stringify({ otherSessions: 'ignore' }));
    const ignored = await runHook({ host: 'claude', stdin: stop(repo.root, 's3') });
    expect(ignored.decision).toBe('block');
    const reason = (JSON.parse(ignored.stdout) as { reason: string }).reason;
    expect(reason).toMatch(/attempt 1\/3/);
    expect(reason).not.toMatch(/ANOTHER AGENT SESSION/);
  });

  it('strict integrity does not hold a session to tests the other session weakened', async () => {
    const test = "it('adds', () => { expect(add(1, 1)).toBe(2); });\n";
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: 'node -e "process.exit(0)"' }), '.isitdone.json': JSON.stringify({ integrity: 'strict' }), 'src/math.test.ts': test, 'src/a.js': 'ok\n' } });
    edit(repo, 's2', 'src/math.test.ts', test.replace("it('adds'", "it.skip('adds'"));
    edit(repo, 's1', 'src/a.js', 'mine\n');
    const mine = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(mine.decision).toBe('allow');
    expect(mine.stdout).not.toMatch(/weakened/);
    const theirs = await runHook({ host: 'claude', stdin: stop(repo.root, 's2') });
    expect(theirs.decision).toBe('block');
    expect((JSON.parse(theirs.stdout) as { reason: string }).reason).toMatch(/weakened the tests/);
  });
});

describe('run lock', () => {
  it('lets one check run at a time, gives up waiting rather than hanging, and is reusable after release', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({}) } });
    const first = await acquireRunLock(repo.root, 50);
    expect(first.held).toBe(true);
    const second = await acquireRunLock(repo.root, 50);
    expect(second.held).toBe(false);
    second.release(); // releasing a lock that was never held must not free the holder's
    expect(existsSync(join(repo.root, '.isitdone', 'run.lock'))).toBe(true);
    first.release();
    expect(existsSync(join(repo.root, '.isitdone', 'run.lock'))).toBe(false);
    const third = await acquireRunLock(repo.root, 50);
    expect(third.held).toBe(true);
    third.release();
  });

  it('takes over a lock whose holder died, and one left empty by a crash', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({}) } });
    const file = join(repo.root, '.isitdone', 'run.lock');
    mkdirSync(join(repo.root, '.isitdone'), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'x', startedAt: Date.now() }));
    const a = await acquireRunLock(repo.root, 50);
    expect(a.held).toBe(true);
    a.release();
    writeFileSync(file, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const b = await acquireRunLock(repo.root, 50);
    expect(b.held).toBe(true);
    b.release();
  });
});
