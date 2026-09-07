import { describe, expect, it } from 'vitest';
import { childEnv, extractSummary, runCheck } from '../src/run.js';
import { FAIL, PASS, SLOW } from './helpers.js';

const cwd = process.cwd();
const check = (cmd: string) => ({ id: 'x', cmd, kind: 'full' as const, source: 'test' });

describe('runCheck', () => {
  it('reports PASS with exit 0', async () => {
    const r = await runCheck(check(PASS), { cwd, timeoutMs: 10_000 });
    expect(r.status).toBe('PASS');
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports FAIL with the exit code and a summary from the tail', async () => {
    const r = await runCheck(check(FAIL), { cwd, timeoutMs: 10_000 });
    expect(r.status).toBe('FAIL');
    expect(r.exitCode).toBe(1);
    expect(r.tail).toContain('1 failed, 2 passed');
    expect(r.summary).toBe('1 failed, 2 passed');
  });

  it('keeps only the last N lines but counts them all', async () => {
    const cmd = 'node -e "for (let i = 0; i < 100; i++) console.log(\'line \' + i)"';
    const r = await runCheck(check(cmd), { cwd, timeoutMs: 10_000, tailLines: 5 });
    expect(r.lines).toBe(100);
    expect(r.tail).toEqual(['line 95', 'line 96', 'line 97', 'line 98', 'line 99']);
  });

  it('merges stderr and strips ANSI', async () => {
    const esc = String.fromCharCode(27);
    const cmd = `node -e "process.stderr.write('${esc}[31mred${esc}[39m err\\n'); console.log('out')"`;
    const r = await runCheck(check(cmd), { cwd, timeoutMs: 10_000 });
    expect(r.tail.sort()).toEqual(['out', 'red err']);
  });

  it('times out and kills the process', async () => {
    const started = Date.now();
    const r = await runCheck(check(SLOW), { cwd, timeoutMs: 800 });
    expect(r.status).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('reports ERROR-ish failure for a missing command', async () => {
    const r = await runCheck(check('definitely-not-a-real-command-xyz --flag'), { cwd, timeoutMs: 10_000 });
    expect(['FAIL', 'ERROR']).toContain(r.status);
    expect(r.exitCode).not.toBe(0);
  });

  it('passes CI/NO_COLOR/ISITDONE to the child', async () => {
    const cmd = 'node -e "console.log([process.env.CI, process.env.NO_COLOR, process.env.ISITDONE].join(\'|\'))"';
    const r = await runCheck(check(cmd), { cwd, timeoutMs: 10_000, env: childEnv({ PATH: process.env.PATH ?? '', Path: process.env.Path ?? '' }) });
    expect(r.tail[0]).toBe('true|1|1');
  });
});

describe('extractSummary', () => {
  it('recognises common runners', () => {
    expect(extractSummary(['...', 'Tests: 1 failed, 2 passed, 3 total'])).toBe('Tests: 1 failed, 2 passed, 3 total');
    expect(extractSummary(['Test Files  1 passed (1)', 'Tests  3 passed (3)'])).toMatch(/passed/);
    expect(extractSummary(['ok  \tx/y\t0.3s'])).toMatch(/^ok/);
    expect(extractSummary(['test result: ok. 3 passed; 0 failed'])).toMatch(/^test result/);
    expect(extractSummary(['src/a.ts(3,1): error TS2322: Type x', 'Found 1 error in src/a.ts'])).toBe('Found 1 error in src/a.ts');
    expect(extractSummary(['4 passed in 0.12s'])).toBe('4 passed in 0.12s');
    expect(extractSummary(['nothing here'])).toBeUndefined();
  });
});
