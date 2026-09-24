import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendDecision, readDecisions, summarizeDecisions, type GateRecord } from '../src/gatelog.js';
import { runHook } from '../src/hook.js';
import { scanHistory } from '../src/history.js';
import { FAIL, PASS, nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
let dir: string | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  dir = null;
});

const DONE = 'Done. All tests pass.';
const stop = (root: string, extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: 's1', transcript_path: '/x.jsonl', cwd: root, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: DONE, ...extra });
const kinds = (root: string) => readDecisions(root).map((r) => r.kind);

describe('decision log', () => {
  it('records what the Stop hook decided: blocked, then passed once fixed', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    expect((await runHook({ host: 'claude', stdin: stop(repo.root) })).decision).toBe('block');
    repo.write('package.json', nodePkg({ test: PASS }));
    expect((await runHook({ host: 'claude', stdin: stop(repo.root, { stop_hook_active: true }) })).decision).toBe('allow');
    expect((await runHook({ host: 'claude', stdin: stop(repo.root) })).decision).toBe('allow');
    expect(kinds(repo.root)).toEqual(['blocked', 'passed', 'passed-cached']);
    const [first] = readDecisions(repo.root);
    expect(first).toMatchObject({ host: 'claude', kind: 'blocked', claim: true, profile: 'full', attempts: 1, checks: 1, failed: 1 });
    expect(first?.session).toMatch(/^claude-[0-9a-f]{16}$/);
    // nothing about the message, the files or the raw session id is kept
    const raw = readFileSync(join(repo.root, '.isitdone', 'decisions.jsonl'), 'utf8');
    expect(raw).not.toMatch(/All tests pass|s1"|package\.json/);
  });

  it('records a lite pass, a stop without a claim, and the cap; nothing for doctor, nested runs or plan mode', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ lint: PASS, test: FAIL }) } });
    await runHook({ host: 'claude', stdin: stop(repo.root, { last_assistant_message: 'Should I also update the docs?' }) });
    for (const active of [false, true, true, true]) await runHook({ host: 'claude', stdin: stop(repo.root, { stop_hook_active: active }) });
    expect(kinds(repo.root)).toEqual(['passed-lite', 'blocked', 'blocked', 'blocked', 'gave-up']);
    expect(readDecisions(repo.root)[0]?.claim).toBe(false);
    await runHook({ host: 'claude', stdin: stop(repo.root), doctor: true });
    await runHook({ host: 'claude', stdin: stop(repo.root), env: { ...process.env, ISITDONE: '1' } });
    await runHook({ host: 'claude', stdin: stop(repo.root, { permission_mode: 'plan' }) });
    expect(readDecisions(repo.root)).toHaveLength(5);
  });

  it('never breaks the hook when .isitdone/ cannot be written, and keeps the newest half past its size limit', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    mkdirSync(join(repo.root, '.isitdone', 'decisions.jsonl'), { recursive: true }); // a directory where the file should be
    expect((await runHook({ host: 'claude', stdin: stop(repo.root) })).decision).toBe('allow');
    rmSync(join(repo.root, '.isitdone', 'decisions.jsonl'), { recursive: true, force: true });
    const rec = (i: number): GateRecord => ({ t: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(), host: 'claude', session: 'claude-0', kind: 'passed', claim: true, profile: 'full', attempts: 0, checks: 1, failed: 0 });
    for (let i = 0; i < 4000; i++) appendDecision(repo.root, rec(i));
    const kept = readDecisions(repo.root);
    expect(kept.length).toBeLessThan(4000);
    expect(kept[kept.length - 1]?.t).toBe(rec(3999).t);
  });
});

describe('summarizeDecisions', () => {
  const r = (session: string, minute: number, kind: GateRecord['kind'], claim: boolean | null = true): GateRecord => ({ t: new Date(Date.UTC(2026, 8, 1, 0, minute)).toISOString(), host: 'claude', session, kind, claim, profile: 'full', attempts: 0, checks: 1, failed: kind === 'blocked' ? 1 : 0 });
  it('folds stops into turns: fixed, gave up, released and still open, per session and in time order', () => {
    const s = summarizeDecisions([
      [r('a', 3, 'passed'), r('a', 1, 'blocked'), r('a', 2, 'blocked'), r('b', 1, 'blocked'), r('b', 2, 'gave-up'), r('a', 4, 'passed-lite', false)],
      [r('c', 1, 'blocked'), r('c', 2, 'released'), r('d', 1, 'blocked'), r('e', 1, 'no-checks')],
      [],
    ]);
    expect(s).toMatchObject({ projects: 2, blockedTurns: 4, fixed: 1, gaveUp: 1, released: 1, open: 1, passed: 2 });
    expect(s.checked).toBe(7); // 5 blocked stops + 2 passes; the give-up, the release and no-checks ran nothing new
    expect(s.claims).toBe(9);
    expect(s.claimsBlocked).toBe(5);
  });
});

describe('history reports what the gate did', () => {
  it('reads the decision log of each project the transcripts name', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    await runHook({ host: 'claude', stdin: stop(repo.root) });
    repo.write('package.json', nodePkg({ test: PASS }));
    await runHook({ host: 'claude', stdin: stop(repo.root, { stop_hook_active: true }) });
    dir = mkdtempSync(join(tmpdir(), 'isitdone-gate-history-'));
    const slug = join(dir, 'proj');
    mkdirSync(slug, { recursive: true });
    const at = (m: number) => new Date(Date.now() - (10 - m) * 60_000).toISOString();
    const recs = [
      { type: 'user', timestamp: at(1), cwd: repo.root, message: { role: 'user', content: 'fix it' } },
      { type: 'assistant', timestamp: at(2), cwd: repo.root, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(repo.root, 'a.js'), old_string: 'a', new_string: 'b' } }] } },
      { type: 'assistant', timestamp: at(3), cwd: repo.root, message: { role: 'assistant', content: [{ type: 'text', text: DONE }] } },
    ];
    writeFileSync(join(slug, 's.jsonl'), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const report = await scanHistory({ projectsDir: dir, codexDir: null, geminiDir: null, qwenDir: null, cursorDir: null, cursorUserDir: null });
    expect(report.claims).toHaveLength(1);
    expect(report.claims[0]?.verdict).toBe('NEVER_RAN'); // the agent ran nothing itself...
    expect(report.gate).toMatchObject({ projects: 1, checked: 2, passed: 1, blockedTurns: 1, fixed: 1, claims: 2, claimsBlocked: 1 }); // ...but the gate did
    expect(existsSync(join(repo.root, '.isitdone', 'decisions.jsonl'))).toBe(true);
  });
});
