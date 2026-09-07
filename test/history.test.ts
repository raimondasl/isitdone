import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSince, projectLabel, scanHistory } from '../src/history.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  dir = null;
});

type Rec = Record<string, unknown>;
let t = Date.parse('2026-09-01T10:00:00Z');
const tick = () => new Date((t += 60_000)).toISOString();

const user = (text: string, extra: Rec = {}): Rec => ({ type: 'user', timestamp: tick(), cwd: '/work/app', message: { role: 'user', content: text }, ...extra });
const edit = (file = '/work/app/src/a.ts'): Rec => ({ type: 'assistant', timestamp: tick(), cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'tool_use', id: `e${t}`, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } });
const bash = (id: string, command: string): Rec => ({ type: 'assistant', timestamp: tick(), cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (id: string, isError = false): Rec => ({ type: 'user', timestamp: tick(), cwd: '/work/app', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'out', is_error: isError }] }, toolUseResult: { stdout: 'out', stderr: '' } });
const say = (text: string, extra: Rec = {}): Rec => ({ type: 'assistant', timestamp: tick(), cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

function session(slug: string, name: string, records: Rec[]): void {
  const d = join(dir as string, slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${name}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), 'isitdone-history-'));
  return dir;
}

describe('scanHistory', () => {
  it('classifies claims as VERIFIED, STALE, FAILED and NEVER_RAN', async () => {
    setup();
    session('C--work-app', 's1', [
      user('add the feature'),
      edit(),
      bash('b1', 'npm test'),
      result('b1'),
      say('Done. All tests pass.'),
      user('now the other thing'),
      edit(),
      bash('b2', 'npx vitest run'),
      result('b2'),
      edit(),
      say('Implemented the change and verified it.'),
      user('and fix the bug'),
      edit(),
      bash('b3', 'pytest -q'),
      result('b3', true),
      say('The fix is complete.'),
      user('one more'),
      edit(),
      bash('b4', 'ls -la'),
      result('b4'),
      say('All done, ready for review.'),
      user('thanks, what does this function do?'),
      say('It parses the config. Done explaining.'),
    ]);
    const r = await scanHistory({ projectsDir: dir as string });
    expect(r.scannedFiles).toBe(1);
    expect(r.editTurns).toBe(4);
    expect(r.claims.map((c) => c.verdict)).toEqual(['VERIFIED', 'STALE', 'FAILED', 'NEVER_RAN']);
    expect(r.counts).toEqual({ VERIFIED: 1, STALE: 1, FAILED: 1, NEVER_RAN: 1 });
    expect(r.verifiedPct).toBe(25);
    expect(r.unbackedPct).toBe(75);
    expect(r.claims[0]?.project).toBe('/work/app');
    expect(r.claims[0]?.claim).toBe('All tests pass.');
    expect(r.byProject).toEqual([{ project: '/work/app', claims: 4, verified: 1, stale: 1, failed: 1, neverRan: 1, unbackedPct: 75 }]);
  });

  it('counts shell edits, typecheck-only turns, and ignores sidechains and turns without edits', async () => {
    setup();
    session('C--work-app', 's2', [
      user('go'),
      bash('b1', 'sed -i "s/a/b/" src/a.ts'),
      result('b1'),
      bash('b2', 'npx tsc --noEmit'),
      result('b2'),
      say('Done, typecheck passes.'),
      user('next'),
      say('Sidechain says done. All tests pass.', { isSidechain: true }),
      edit(),
      say('I have not run the tests yet.'),
    ]);
    const r = await scanHistory({ projectsDir: dir as string });
    expect(r.claims.map((c) => [c.verdict, c.checkRuns, c.testRuns])).toEqual([['NEVER_RAN', 1, 0]]);
    expect(r.editTurns).toBe(2);
  });

  it('excludes projects by slug or cwd substring and honours since', async () => {
    setup();
    session('C--work-app', 's3', [user('a'), edit(), say('Done.')]);
    session('C--work-secret-ops', 's4', [user('a'), edit(), say('Done.')]);
    session('C--other', 's5', [user('a', { cwd: '/elsewhere/secret-thing' }), { ...edit('/elsewhere/x'), cwd: '/elsewhere/secret-thing' }, { ...say('Done.'), cwd: '/elsewhere/secret-thing' }]);
    const r = await scanHistory({ projectsDir: dir as string, exclude: ['secret'] });
    expect(r.excludedDirs).toEqual(['C--work-secret-ops']);
    expect(r.claims.map((c) => c.project)).toEqual(['/work/app']);
    const none = await scanHistory({ projectsDir: dir as string, since: new Date('2030-01-01') });
    expect(none.claims).toEqual([]);
    expect(none.skippedFiles).toBe(3);
  });

  it('handles a missing projects dir and malformed lines', async () => {
    setup();
    const r = await scanHistory({ projectsDir: join(dir as string, 'nope') });
    expect(r.scannedFiles).toBe(0);
    const d = join(dir as string, 'C--x');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'bad.jsonl'), 'not json\n{"type":"user"}\n{"type":"assistant","message":{"content":"string not array"}}\n');
    const r2 = await scanHistory({ projectsDir: dir as string });
    expect(r2.scannedFiles).toBe(1);
    expect(r2.claims).toEqual([]);
  });
});

describe('helpers', () => {
  it('parseSince accepts relative and absolute forms', () => {
    const d = parseSince('30d');
    expect(d && Date.now() - d.getTime()).toBeGreaterThan(29 * 86_400_000);
    expect(parseSince('2026-01-02')?.toISOString().slice(0, 10)).toBe('2026-01-02');
    expect(parseSince('soon')).toBeNull();
  });
  it('projectLabel decodes slugs', () => {
    expect(projectLabel('C--Users-me-work-app', null)).toBe('C:/Users/me/work/app');
    expect(projectLabel('-home-me-app', null)).toBe('/home/me/app');
    expect(projectLabel('x', '/real/path')).toBe('/real/path');
  });
});
