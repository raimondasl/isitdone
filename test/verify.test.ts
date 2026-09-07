import { afterEach, describe, expect, it } from 'vitest';
import { formatBlockReason, formatMarkdown, formatReport, toJson } from '../src/report.js';
import { plain } from '../src/output.js';
import { verify } from '../src/verify.js';
import { FAIL, PASS, nodePkg, tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

describe('verify', () => {
  it('runs all checks in full profile and writes a PASS receipt', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS, lint: PASS }) } });
    const res = await verify({ root: repo.root, config: {}, profile: 'full', claim: 'All tests pass', host: 'test-host' });
    expect(res.ok).toBe(true);
    expect(res.cached).toBe(false);
    expect(res.ran.map((r) => `${r.id}:${r.status}`)).toEqual(['lint:PASS', 'test:PASS']);
    expect(res.receipt?.status).toBe('PASS');
    expect(res.receipt?.profile).toBe('full');
    expect(res.receipt?.claim).toBe('All tests pass');
    expect(res.receipt?.host).toBe('test-host');
    expect(res.before.state).toBe('NONE');
  });

  it('short-circuits on a cached PASS receipt for the same tree, and re-runs after a change', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    await verify({ root: repo.root, config: {}, profile: 'full' });
    const cached = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(cached.cached).toBe(true);
    expect(cached.ok).toBe(true);
    expect(cached.ran).toEqual([]);
    repo.write('src.js', '// change');
    const rerun = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(rerun.cached).toBe(false);
    expect(rerun.before.state).toBe('STALE');
    expect(rerun.ran).toHaveLength(1);
    const forced = await verify({ root: repo.root, config: {}, profile: 'full', useCache: false });
    expect(forced.cached).toBe(false);
  });

  it('a lite PASS receipt does not satisfy a full request', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS, lint: PASS }) } });
    const lite = await verify({ root: repo.root, config: {}, profile: 'lite' });
    expect(lite.ok).toBe(true);
    expect(lite.receipt?.profile).toBe('lite');
    expect(lite.ran.map((r) => r.id)).toEqual(['lint']);
    expect(lite.skipped.map((s) => s.check.id)).toEqual(['test']);
    const full = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(full.cached).toBe(false);
    expect(full.ran.map((r) => r.id)).toEqual(['lint', 'test']);
    const liteAgain = await verify({ root: repo.root, config: {}, profile: 'lite' });
    expect(liteAgain.cached).toBe(true);
  });

  it('fails, writes a FAIL receipt, and skips full checks after a lite failure unless --all', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS, lint: FAIL }) } });
    const res = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(res.ok).toBe(false);
    expect(res.ran.map((r) => `${r.id}:${r.status}`)).toEqual(['lint:FAIL']);
    expect(res.skipped[0]?.check.id).toBe('test');
    expect(res.skipped[0]?.reason).toMatch(/lite check failed/);
    expect(res.receipt?.status).toBe('FAIL');
    const all = await verify({ root: repo.root, config: {}, profile: 'full', all: true });
    expect(all.ran.map((r) => `${r.id}:${r.status}`)).toEqual(['lint:FAIL', 'test:PASS']);
    expect(all.ok).toBe(false);
  });

  it('a FAIL receipt never counts as cached', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    await verify({ root: repo.root, config: {}, profile: 'full' });
    const again = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(again.cached).toBe(false);
    expect(again.before.state).toBe('FAIL');
  });

  it('with no checks detected it is ok and writes no receipt', async () => {
    repo = tempRepo({ files: { 'README.md': 'x' } });
    const res = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(res.ok).toBe(true);
    expect(res.receipt).toBeNull();
    expect(formatReport(res, plain)).toMatch(/no checks detected/);
    expect(toJson(res, 'NONE').done).toBe(true);
  });

  it('honours config overrides and per-check timeouts', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }), '.isitdone.json': '{}' } });
    const res = await verify({
      root: repo.root,
      config: { checks: { test: PASS, slow: { cmd: 'node -e "setTimeout(function(){}, 5000)"', kind: 'full', timeout: 1 } } },
      profile: 'full',
    });
    expect(res.ran.map((r) => `${r.id}:${r.status}`)).toEqual(['test:PASS', 'slow:TIMEOUT']);
    expect(res.ok).toBe(false);
  });

  it('works outside a git repo (no caching, receipt always STALE)', async () => {
    repo = tempRepo({ git: false, files: { 'package.json': nodePkg({ test: PASS }) } });
    const res = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(res.ok).toBe(true);
    expect(res.git.isRepo).toBe(false);
    const again = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(again.cached).toBe(false);
    expect(again.before.state).toBe('STALE');
  });

  it('calls progress callbacks in order', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS, lint: PASS }) } });
    const events: string[] = [];
    await verify({
      root: repo.root,
      config: {},
      profile: 'full',
      onCheckStart: (c) => events.push(`start:${c.id}`),
      onCheckDone: (r) => events.push(`done:${r.id}:${r.status}`),
    });
    expect(events).toEqual(['start:lint', 'done:lint:PASS', 'start:test', 'done:test:PASS']);
  });
});

describe('report formatting', () => {
  it('formats a failing report, block reason, markdown and json', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL, lint: PASS }) } });
    const res = await verify({ root: repo.root, config: {}, profile: 'full', claim: 'All 48 tests pass' });
    const report = formatReport(res, plain);
    expect(report).toMatch(/NOT DONE/);
    expect(report).toMatch(/claim: "All 48 tests pass"/);
    expect(report).toMatch(/npm test\s+FAIL\s+\S+\s+1 failed, 2 passed/);
    expect(report).toMatch(/npm run lint\s+PASS/);

    const reason = formatBlockReason(res, 1, 3);
    expect(reason.split('\n').length).toBeLessThanOrEqual(40);
    expect(reason).toMatch(/^isitdone: NOT DONE\. 1 check failed/);
    expect(reason).toMatch(/You claimed: "All 48 tests pass"/);
    expect(reason).toMatch(/Do not skip, delete or weaken tests/);

    const md = formatMarkdown(res.receipt!, 'FAIL');
    expect(md).toMatch(/^\| check \| result \| time \|/);
    expect(md).toMatch(/`npm test` \| FAIL \(1 failed, 2 passed\)/);
    expect(md).toMatch(/Receipt: \*\*FAIL\*\*/);

    const json = toJson(res, 'FAIL');
    expect(json.ok).toBe(false);
    expect(json.done).toBe(false);
    expect((json.checks as unknown[]).length).toBe(2);
  });

  it('json.done is true only for a full PASS', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS, lint: PASS }) } });
    const lite = await verify({ root: repo.root, config: {}, profile: 'lite' });
    expect(toJson(lite, 'PASS').done).toBe(false);
    const full = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(toJson(full, 'PASS').done).toBe(true);
    const cached = await verify({ root: repo.root, config: {}, profile: 'full' });
    expect(toJson(cached, 'PASS').done).toBe(true);
    expect(formatReport(cached, plain)).toMatch(/PASS \(cached\)/);
  });
});
