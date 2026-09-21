import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dirtyPathSet } from '../src/git.js';
import { readState, runEditHook, runHook, writeState } from '../src/hook.js';
import { verify } from '../src/verify.js';
import { ACTIVE_WINDOW_MS, acquireRunLock, attribute, liveSessionsNote, mentionContext, mentions, readSessions, recordEdits, sessionKey } from '../src/sessions.js';
import { FAIL, PASS, nodePkg, tempRepo, type TempRepo } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const again = { stop_hook_active: true };
const reasonOf = (stdout: string) => (JSON.parse(stdout) as { reason: string }).reason;
/** The session edits a file: the file changes and the post-edit hook fires, as it would in the host. */
function edit(r: TempRepo, session: string, file: string, content: string, cwd = r.root) {
  r.write(file, content);
  runEditHook({ host: 'claude', stdin: JSON.stringify({ session_id: session, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(r.root, file), old_string: 'a', new_string: 'b' } }) });
}
const MIN = 60_000;

describe('attribution needs proof of a concurrent session', () => {
  it('a conversation that ended before this one began (/clear, a restart) is not another session', () => {
    repo = twoFileRepo();
    const now = Date.now();
    repo.write('src/b.js', 'left behind\n');
    recordEdits(repo.root, 'claude', 'task-1', ['src/b.js'], now - 10 * MIN);
    recordEdits(repo.root, 'claude', 'task-2', ['src/a.js'], now - 5 * MIN);
    repo.write('src/a.js', 'mine\n');
    expect(attribute([repo.root], 'claude', 'task-2', () => dirtyPathSet(repo!.root), now)).toBeNull();
    // and a session whose first sign of life is this very stop has no proof about anyone
    expect(attribute([repo.root], 'claude', 'task-3', () => dirtyPathSet(repo!.root), now)).toBeNull();
  });

  it('sorts uncommitted files into mine, the concurrent session\'s, and shared once their activity overlaps', () => {
    repo = twoFileRepo({ 'src/c.js': 'ok\n' });
    const now = Date.now();
    for (const f of ['src/a.js', 'src/b.js', 'src/c.js']) repo.write(f, 'changed\n');
    recordEdits(repo.root, 'claude', 's1', ['src/a.js', 'src/c.js'], now - 10 * MIN);
    recordEdits(repo.root, 'claude', 's2', ['src/b.js', 'src/c.js'], now - 5 * MIN);
    const a = attribute([repo.root], 'claude', 's1', () => dirtyPathSet(repo!.root), now);
    expect([...(a?.mine ?? [])].sort()).toEqual(['src/a.js', 'src/c.js']);
    expect(a?.foreign.map((f) => f.path)).toEqual(['src/b.js']);
    expect(a?.shared.map((f) => f.path)).toEqual(['src/c.js']);
    // s2 has seen nothing from s1 since it began: no proof yet. One more edit by s1 is the proof.
    expect(attribute([repo.root], 'claude', 's2', () => dirtyPathSet(repo!.root), now)).toBeNull();
    recordEdits(repo.root, 'claude', 's1', ['src/a.js'], now - 1 * MIN);
    expect(attribute([repo.root], 'claude', 's2', () => dirtyPathSet(repo!.root), now)?.foreign.map((f) => f.path)).toEqual(['src/a.js']);
  });

  it('what a session finished and verified is not work in progress: only edits after its last passing stop count', () => {
    repo = twoFileRepo({ 'src/c.js': 'ok\n' });
    const now = Date.now();
    const iso = (t: number) => new Date(t).toISOString();
    for (const f of ['src/a.js', 'src/b.js', 'src/c.js']) repo.write(f, 'changed\n');
    recordEdits(repo.root, 'claude', 's1', ['src/a.js'], now - 20 * MIN);
    // a helper session edited b.js and c.js, passed its stop, and exited (or is idle): nothing of it is in progress
    recordEdits(repo.root, 'claude', 'helper', ['src/b.js', 'src/c.js'], now - 10 * MIN);
    writeState(repo.root, { host: 'claude', sessionId: 'helper', turnId: null, attempts: 0, loopCount: null, lastTree: null, firstSeen: iso(now - 10 * MIN), lastPassAt: iso(now - 9 * MIN), updatedAt: iso(now - 9 * MIN) });
    expect(attribute([repo.root], 'claude', 's1', () => dirtyPathSet(repo!.root), now)).toBeNull();
    expect(liveSessionsNote([repo.root], () => dirtyPathSet(repo!.root), now)).toBeNull();
    // it gets a new prompt and edits c.js again: that file, and only that file, is in progress
    recordEdits(repo.root, 'claude', 'helper', ['src/c.js'], now - 2 * MIN);
    expect(attribute([repo.root], 'claude', 's1', () => dirtyPathSet(repo!.root), now)?.foreign.map((x) => x.path)).toEqual(['src/c.js']);
  });

  it('counts only positive, recent evidence: committed files, long-quiet sessions and id-less payloads prove nothing', () => {
    repo = twoFileRepo();
    const now = Date.now();
    recordEdits(repo.root, 'claude', 's1', ['src/a.js'], now - 10 * MIN);
    recordEdits(repo.root, 'claude', 's2', ['src/b.js'], now - 5 * MIN);
    // nothing is dirty: s2's work landed
    expect(attribute([repo.root], 'claude', 's1', () => dirtyPathSet(repo!.root), now)).toBeNull();
    repo.write('src/b.js', 'dirty again\n');
    expect(attribute([repo.root], 'claude', 's1', () => dirtyPathSet(repo!.root), now)?.foreign).toHaveLength(1);
    expect(attribute([repo.root], 'claude', 's1', () => dirtyPathSet(repo!.root), now + ACTIVE_WINDOW_MS)).toBeNull();
    expect(attribute([repo.root], 'claude', null, () => dirtyPathSet(repo!.root), now)).toBeNull();
    const before = readSessions([repo.root]).length;
    recordEdits(repo.root, 'claude', null, ['src/a.js']);
    expect(readSessions([repo.root])).toHaveLength(before);
  });

  it('records under the git top-level whatever directory the session is in, even with the integrity scan off, never outside the repository', () => {
    repo = twoFileRepo({ '.isitdone.json': JSON.stringify({ integrity: 'off' }), 'packages/a/package.json': nodePkg({ test: PASS }), 'packages/a/src/x.js': 'ok\n' });
    edit(repo, 's2', 'packages/a/src/x.js', 'theirs\n', join(repo.root, 'packages', 'a'));
    runEditHook({ host: 'claude', stdin: JSON.stringify({ session_id: 's2', cwd: repo.root, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(repo.root, '..', 'elsewhere.txt') } }) });
    expect(existsSync(join(repo.root, 'packages', 'a', '.isitdone'))).toBe(false);
    expect(readdirSync(join(repo.root, '.isitdone', 'sessions'))).toEqual([`${sessionKey('claude', 's2')}.edits`]);
    expect([...(readSessions([repo.root])[0]?.files.keys() ?? [])]).toEqual(['packages/a/src/x.js']);
  });

  it('the CLI note names who edited what only for sessions whose activity overlapped', () => {
    repo = twoFileRepo();
    const now = Date.now();
    repo.write('src/a.js', 'x\n');
    repo.write('src/b.js', 'y\n');
    recordEdits(repo.root, 'claude', 'old', ['src/b.js'], now - 10 * MIN);
    recordEdits(repo.root, 'claude', 'new', ['src/a.js'], now - 5 * MIN);
    expect(liveSessionsNote([repo.root], () => dirtyPathSet(repo!.root), now)).toBeNull();
    recordEdits(repo.root, 'claude', 'old', ['src/b.js'], now - 1 * MIN);
    const note = liveSessionsNote([repo.root], () => dirtyPathSet(repo!.root), now) ?? '';
    expect(note).toMatch(/2 agent sessions have uncommitted edits/);
    expect(note).toMatch(/claude-[0-9a-f]{6} \(active 60 s ago\): src\/b\.js/);
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
  const REPO = [
    'src/a.ts', 'src/a.tsx', 'src/index.ts', 'packages/a/src/index.ts', 'packages/a/src/foo.js', 'packages/b/src/bar.js', 'utils.js', 'test/utils.js', 'conftest.py', 'tests/conftest.py',
    'backend/app/calc.py', 'pkg/orders/handler_test.go', 'pkg/users/handler_test.go', 'internal/scan/scanner_test.go', 'src/test/java/com/x/ScannerTest.java', 'app/(group)/[id]/page.tsx',
    'src/reporadar/scan.py', 'tests/test_scan.py', 'src/pkg/utils.py', 'my dir/sub dir/thing.py',
  ];
  const named = (output: string, file: string, fold = false, top = 'C:/work/repo') => mentions(mentionContext(output, top, [...REPO, ...REPO], fold), file);

  it('finds a path as tools print it', () => {
    expect(named('src/reporadar/scan.py:12: error: Incompatible types', 'src/reporadar/scan.py')).toBe(true);
    expect(named('FAILED tests/test_scan.py::test_x - assert 1 == 2', 'tests/test_scan.py')).toBe(true);
    expect(named(String.raw`C:\work\repo\src\a.ts(3,5): error TS2322`, 'src/a.ts')).toBe(true);
    expect(named(String.raw`c:\WORK\repo\src\a.ts(3,5): error TS2322`, 'src/a.ts', true)).toBe(true); // a tool that lower-cases Windows paths
    expect(named('./src/a.ts:3:5 - error', 'src/a.ts')).toBe(true);
    expect(named('    at assertSum (src/a.ts:5:11)', 'src/a.ts')).toBe(true);
    expect(named('\u001b[96msrc/a.ts\u001b[0m:\u001b[93m1\u001b[0m:5 - error TS2322', 'src/a.ts')).toBe(true); // forced colour
    expect(named('app/(group)/[id]/page.tsx(4,2): error', 'app/(group)/[id]/page.tsx')).toBe(true);
  });

  it('accepts what a check run from a sub-directory or workspace prints, when only one repository file ends that way', () => {
    expect(named('  at Object.<anonymous> (src/foo.js:3:9)', 'packages/a/src/foo.js')).toBe(true);
    expect(named('app/calc.py:3: in add', 'backend/app/calc.py')).toBe(true);
    expect(named('src/index.ts(3,1): error', 'packages/a/src/index.ts')).toBe(false); // src/index.ts is another file
  });

  it('is not fooled by a longer path, a neighbour, or a source map', () => {
    expect(named('at assertSum (test/utils.js:5:11)', 'utils.js')).toBe(false);
    expect(named('tests/conftest.py:14: in fixture', 'conftest.py')).toBe(false);
    expect(named('packages/a/src/index.ts(3,1): error', 'src/index.ts')).toBe(false);
    expect(named('C:/elsewhere/src/a.ts:1', 'src/a.ts')).toBe(false);
    expect(named('node_modules/x/src/a.ts:1', 'src/a.ts')).toBe(false);
    expect(named('src/a.tsx(3,5): error', 'src/a.ts')).toBe(false);
    expect(named('src/a.ts.map', 'src/a.ts')).toBe(false);
    expect(named('xsrc/a.ts:1', 'src/a.ts')).toBe(false);
  });

  it('copes with spaces and brackets: a top-level with spaces, a directory with spaces, a Next.js path inside a stack frame', () => {
    const top = 'C:/Users/John Smith/OneDrive - Company/repo';
    expect(named(String.raw`C:\Users\John Smith\OneDrive - Company\repo\src\a.ts(3,5): error TS2322`, 'src/a.ts', false, top)).toBe(true);
    expect(named(String.raw`C:\Users\John Smith\OneDrive - Company\repo\utils.js:3`, 'utils.js', false, top)).toBe(true); // anchored: test/utils.js does not matter
    expect(named(String.raw`C:\Users\John Smith\OneDrive - Company\repo\test\utils.js:3`, 'utils.js', false, top)).toBe(false);
    expect(named('my dir/sub dir/thing.py:4: error', 'my dir/sub dir/thing.py')).toBe(true);
    expect(named('    at Page (app/(group)/[id]/page.tsx:4:2)', 'app/(group)/[id]/page.tsx')).toBe(true);
  });

  it('stays linear on one enormous line', () => {
    const line = 'q/a.ts/'.repeat(150_000); // one unbroken megabyte with 150,000 base-name hits that resolve to nothing
    const started = Date.now();
    expect(named(line, 'src/a.ts')).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('takes a bare Name.ext:line only for a distinctive name that is unique in the repository', () => {
    expect(named('    scanner_test.go:41: got 3, want 4', 'internal/scan/scanner_test.go')).toBe(true);
    expect(named('\tat com.x.ScannerTest.finds(ScannerTest.java:17)', 'src/test/java/com/x/ScannerTest.java')).toBe(true);
    expect(named('    handler_test.go:23: boom\nFAIL example.com/app/pkg/users', 'pkg/orders/handler_test.go')).toBe(false);
    expect(named('    utils.py:3: in helper', 'src/pkg/utils.py')).toBe(false);
    expect(named('see scanner_test.go for details', 'internal/scan/scanner_test.go')).toBe(false);
  });
});

describe('Stop hook with another session in the same working tree', () => {
  it('gates a single user exactly as before after /clear: the ended conversation\'s leftovers are not "another session"', async () => {
    repo = twoFileRepo();
    edit(repo, 'task-1', 'src/b.js', 'BROKEN\n'); // the old conversation left this behind, then the user typed /clear
    edit(repo, 'task-2', 'src/a.js', 'fine\n');
    for (const n of [1, 2, 3]) {
      const o = await runHook({ host: 'claude', stdin: stop(repo.root, 'task-2', n === 1 ? {} : again) });
      expect(o.decision).toBe('block');
      expect(reasonOf(o.stdout)).toMatch(new RegExp(`attempt ${n}/3`));
      expect(reasonOf(o.stdout)).not.toMatch(/ANOTHER AGENT SESSION/);
    }
  });

  it('a helper session that passed and exited does not soften the gate: its files were good when it left them', async () => {
    repo = twoFileRepo();
    edit(repo, 's1', 'src/a.js', 'fine\n');
    edit(repo, 'helper', 'src/b.js', 'also fine\n');
    expect((await runHook({ host: 'claude', stdin: stop(repo.root, 'helper') })).decision).toBe('allow');
    repo.write('src/b.js', 'BROKEN\n'); // s1 breaks the helper's finished file (through the shell: no record)
    for (const n of [1, 2, 3]) {
      const o = await runHook({ host: 'claude', stdin: stop(repo.root, 's1', n === 1 ? {} : again) });
      expect(o.decision).toBe('block');
      expect(reasonOf(o.stdout)).toMatch(new RegExp(`attempt ${n}/3`));
      expect(reasonOf(o.stdout)).not.toMatch(/ANOTHER AGENT SESSION/);
    }
  });

  it('a failure that names only the other session\'s files: told once, checks run again, then released with the receipt at FAIL', async () => {
    repo = twoFileRepo();
    edit(repo, 's1', 'src/a.js', 'fine\n');
    edit(repo, 's2', 'src/b.js', 'BROKEN\n');
    const first = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(first.decision).toBe('block');
    const reason = reasonOf(first.stdout);
    expect(reason).toMatch(/ANOTHER AGENT SESSION HAS BEEN WORKING IN THIS SAME DIRECTORY/);
    expect(reason).toMatch(/not yours:\n {2}src\/b\.js {2}\(edited \d+ s ago\)/);
    expect(reason).toMatch(/Do not edit, revert or "fix" them/);
    expect(reason).toMatch(/Nothing in this output names a file you edited/);
    expect(reason.indexOf('ANOTHER AGENT SESSION')).toBeLessThan(reason.indexOf('npm test'));
    const second = await runHook({ host: 'claude', stdin: stop(repo.root, 's1', again) });
    expect(second.decision).toBe('allow');
    expect(second.result?.ok).toBe(false); // the checks ran again: nothing is waved through unseen
    expect(second.stdout).toMatch(/let go after one block/);
    expect(second.stdout).toMatch(/src\/b\.js/);
    expect(JSON.parse(readFileSync(join(repo.root, '.isitdone', 'receipt.json'), 'utf8')).status).toBe('FAIL');
    // The session that broke it is held to it in full, and told to keep off the first session's file.
    const other = await runHook({ host: 'claude', stdin: stop(repo.root, 's2') });
    expect(reasonOf(other.stdout)).toMatch(/attempt 1\/3/);
    expect(reasonOf(other.stdout)).toMatch(/not yours:\n {2}src\/a\.js/);
    const otherAgain = await runHook({ host: 'claude', stdin: stop(repo.root, 's2', again) });
    expect(otherAgain.decision).toBe('block');
    expect(reasonOf(otherAgain.stdout)).toMatch(/attempt 2\/3/);
  });

  it('a session that fixed its own files is released although the other session\'s still fail; one that did not is blocked again', async () => {
    repo = twoFileRepo();
    edit(repo, 's1', 'src/a.js', 'BROKEN\n');
    edit(repo, 's2', 'src/b.js', 'BROKEN\n');
    const first = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(reasonOf(first.stdout)).toMatch(/attempt 1\/3/);
    expect(reasonOf(first.stdout)).toMatch(/Fix the failures in your own files/);
    const still = await runHook({ host: 'claude', stdin: stop(repo.root, 's1', again) });
    expect(reasonOf(still.stdout)).toMatch(/attempt 2\/3/);
    edit(repo, 's1', 'src/a.js', 'fixed\n');
    const o = await runHook({ host: 'claude', stdin: stop(repo.root, 's1', again) });
    expect(o.decision).toBe('allow');
    expect(o.why).toMatch(/not tied to this session/);
  });

  it('a failure that names nobody\'s files blocks once, and the release comes only after the checks ran again', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), 'src/a.js': 'ok\n', 'src/b.js': 'ok\n' } });
    edit(repo, 's1', 'src/a.js', 'mine\n');
    edit(repo, 's2', 'src/b.js', 'theirs\n');
    const first = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(first.decision).toBe('block');
    expect(readState(repo.root, 'claude', 's1')?.softBlocks).toBe(1);
    // the agent found it was its own doing after all and fixed it: the second stop is a real PASS, not a shrug
    repo.write('package.json', nodePkg({ test: PASS }));
    const fixed = await runHook({ host: 'claude', stdin: stop(repo.root, 's1', again) });
    expect(fixed.decision).toBe('allow');
    expect(fixed.result?.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(repo.root, '.isitdone', 'receipt.json'), 'utf8')).status).toBe('PASS');
  });

  it('a lite failure in the other session\'s file does not hide this session\'s failing tests', async () => {
    repo = twoFileRepo();
    repo.write('package.json', nodePkg({ lint: 'node -e "console.log(\'src/b.js:1: lint error\'); process.exit(1)"', test: 'node check.js' }));
    repo.commit('lint');
    edit(repo, 's1', 'src/a.js', 'BROKEN\n');
    edit(repo, 's2', 'src/b.js', 'changed\n');
    const o = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    const reason = reasonOf(o.stdout);
    expect(reason).toMatch(/src\/a\.js:1: error: broken/);
    expect(reason).toMatch(/Fix the failures in your own files/);
  });

  it('a session with no edit records (a host without a post-edit hook) is gated as if it were alone, with the note', async () => {
    repo = twoFileRepo();
    const cursor = (loop: number) => JSON.stringify({ conversation_id: 'c1', generation_id: `g${loop}`, workspace_roots: [repo!.root], hook_event_name: 'stop', status: 'completed', loop_count: loop });
    edit(repo, 's2', 'src/b.js', 'BROKEN\n');
    const first = await runHook({ host: 'cursor', stdin: cursor(0) });
    expect(first.decision).toBe('block');
    edit(repo, 's2', 'src/b.js', 'BROKEN still\n'); // the Claude session keeps working: now there is proof
    const second = await runHook({ host: 'cursor', stdin: cursor(1) });
    expect(second.decision).toBe('block');
    expect(second.attempts).toBe(2);
    expect(JSON.stringify(JSON.parse(second.stdout))).toMatch(/ANOTHER AGENT SESSION/);
    expect(JSON.stringify(JSON.parse(second.stdout))).toMatch(/no record of which files YOU edited/);
    expect(JSON.stringify(JSON.parse(second.stdout))).not.toMatch(/not yours/);
    const third = await runHook({ host: 'cursor', stdin: cursor(2) });
    expect(third.decision).toBe('block');
    expect(third.attempts).toBe(3);
  });

  it('strict integrity is not relaxed for a session that has no edit records of its own', async () => {
    const test = "it('adds', () => { expect(add(1, 1)).toBe(2); });\n";
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }), '.isitdone.json': JSON.stringify({ integrity: 'strict' }), 'src/math.test.ts': test } });
    const cursor = (loop: number) => JSON.stringify({ conversation_id: 'c1', generation_id: `g${loop}`, workspace_roots: [repo!.root], hook_event_name: 'stop', status: 'completed', loop_count: loop });
    expect((await runHook({ host: 'cursor', stdin: cursor(0) })).decision).toBe('allow');
    edit(repo, 's2', 'src/math.test.ts', test.replace("it('adds'", "it.skip('adds'"));
    const o = await runHook({ host: 'cursor', stdin: cursor(0) });
    expect(o.decision).toBe('block');
    expect(JSON.stringify(JSON.parse(o.stdout))).toMatch(/weakened the tests/);
  });

  it('where a continuation is only inferred, a telling from an abandoned turn does not release the next one unblocked', async () => {
    repo = twoFileRepo();
    const flagless = (session: string) => JSON.stringify({ session_id: session, transcript_path: '/x.jsonl', cwd: repo!.root, permission_mode: 'default', hook_event_name: 'Stop', last_assistant_message: DONE });
    edit(repo, 's1', 'src/a.js', 'fine\n');
    edit(repo, 's2', 'src/b.js', 'BROKEN\n');
    process.env.CONTINUE_PROJECT_DIR = repo.root; // Continue drives the Claude hook shape without stop_hook_active
    try {
      expect((await runHook({ host: 'claude', stdin: flagless('s1') })).decision).toBe('block');
      // the user interrupted that turn; a quarter of an hour later a new turn ends with the same kind of failure
      const st = readState(repo.root, 'claude', 's1');
      writeState(repo.root, { ...st!, updatedAt: new Date(Date.now() - 15 * MIN).toISOString() });
      edit(repo, 's2', 'src/b.js', 'BROKEN still\n');
      const next = await runHook({ host: 'claude', stdin: flagless('s1') });
      expect(next.decision).toBe('block');
    } finally {
      delete process.env.CONTINUE_PROJECT_DIR;
    }
  });

  it('"otherSessions": "ignore" switches off the note, the single block and the run lock', async () => {
    repo = twoFileRepo({ '.isitdone.json': JSON.stringify({ otherSessions: 'ignore' }) });
    edit(repo, 's1', 'src/a.js', 'fine\n');
    edit(repo, 's2', 'src/b.js', 'BROKEN\n');
    mkdirSync(join(repo.root, '.isitdone'), { recursive: true });
    writeFileSync(join(repo.root, '.isitdone', 'run.lock'), JSON.stringify({ pid: process.pid, token: 'someone-else', startedAt: Date.now() }));
    const started = Date.now();
    const first = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(reasonOf(first.stdout)).toMatch(/attempt 1\/3/);
    expect(reasonOf(first.stdout)).not.toMatch(/ANOTHER AGENT SESSION/);
    const second = await runHook({ host: 'claude', stdin: stop(repo.root, 's1', again) });
    expect(reasonOf(second.stdout)).toMatch(/attempt 2\/3/);
  });

  it('a cached PASS never waits for the run lock', async () => {
    repo = twoFileRepo();
    expect((await runHook({ host: 'claude', stdin: stop(repo.root, 's1') })).decision).toBe('allow');
    writeFileSync(join(repo.root, '.isitdone', 'run.lock'), JSON.stringify({ pid: process.pid, token: 'someone-else', startedAt: Date.now() }));
    const started = Date.now();
    const o = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(o.why).toMatch(/cached PASS/);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('strict integrity leaves tests the other session weakened to that session, and says so', async () => {
    const test = "it('adds', () => { expect(add(1, 1)).toBe(2); });\n";
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }), '.isitdone.json': JSON.stringify({ integrity: 'strict' }), 'src/math.test.ts': test, 'src/a.js': 'ok\n' } });
    edit(repo, 's1', 'src/a.js', 'mine\n');
    edit(repo, 's2', 'src/math.test.ts', test.replace("it('adds'", "it.skip('adds'"));
    const mine = await runHook({ host: 'claude', stdin: stop(repo.root, 's1') });
    expect(mine.decision).toBe('allow');
    expect(mine.stdout).toMatch(/1 test-integrity finding is in files another session edited and was left to that session/);
    const theirs = await runHook({ host: 'claude', stdin: stop(repo.root, 's2') });
    expect(theirs.decision).toBe('block');
    expect(reasonOf(theirs.stdout)).toMatch(/weakened the tests/);
  });
});

describe('a check run that overlapped someone\'s edits', () => {
  const SLOW_PASS = 'node -e "setTimeout(function(){ process.exit(0); }, 3000)"';
  for (const recorded of [true, false]) {
    it(`is not reused by the stop that waited for it (${recorded ? 'recorded edit: receipt bound to the tree the run started on' : 'unrecorded edit: the waiter runs for itself'})`, async () => {
      repo = tempRepo({ files: { 'package.json': nodePkg({ test: SLOW_PASS }), 'src/a.js': 'ok\n' } });
      const root = repo.root;
      const first = verify({ root, config: {}, profile: 'full', lockWaitMs: 20_000 });
      await sleep(700);
      repo.write('src/a.js', 'edited while the first run was already going\n');
      if (recorded) recordEdits(root, 'claude', 'other', ['src/a.js']);
      const second = verify({ root, config: {}, profile: 'full', lockWaitMs: 20_000 });
      const [a, b] = await Promise.all([first, second]);
      expect(a.ok).toBe(true);
      expect(b.lock?.waitedMs ?? 0).toBeGreaterThan(1000);
      expect(b.cached).toBe(false); // the first run's PASS says nothing about the edited tree
      expect(b.ran).toHaveLength(1);
      if (recorded) expect(a.warnings.join(' ')).toMatch(/files were edited while the checks ran/);
    }, 60_000);
  }
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

  it('trusts a heartbeat, not a pid: a fresh lock is respected whoever wrote it, one that stopped beating is taken over', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({}) } });
    const file = join(repo.root, '.isitdone', 'run.lock');
    mkdirSync(join(repo.root, '.isitdone'), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'x', startedAt: Date.now() }));
    expect((await acquireRunLock(repo.root, 50)).held).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const a = await acquireRunLock(repo.root, 1000);
    expect(a.held).toBe(true);
    a.release();
    // a holder whose pid is gone here and that missed two beats is dead; the same age with a live pid is not
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead', startedAt: Date.now() }));
    const missedTwoBeats = new Date(Date.now() - 15_000);
    utimesSync(file, missedTwoBeats, missedTwoBeats);
    const c = await acquireRunLock(repo.root, 1000);
    expect(c.held).toBe(true);
    expect(c.tookOver).toBe(true);
    c.release();
    writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'alive', startedAt: Date.now() }));
    utimesSync(file, missedTwoBeats, missedTwoBeats);
    expect((await acquireRunLock(repo.root, 50)).held).toBe(false);
    writeFileSync(file, ''); // left empty by a process that died between create and write
    utimesSync(file, old, old);
    const b = await acquireRunLock(repo.root, 1000);
    expect(b.held).toBe(true);
    b.release();
  });
});
