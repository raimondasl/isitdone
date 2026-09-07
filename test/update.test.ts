import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findNpxEntries, isNewer, npmCacheDir, runUpdate } from '../src/update.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  dir = null;
});

function fakeCache(entries: Record<string, Record<string, string>>): string {
  dir = mkdtempSync(join(tmpdir(), 'isitdone-npm-cache-'));
  for (const [hash, dependencies] of Object.entries(entries)) {
    const d = join(dir, '_npx', hash);
    mkdirSync(join(d, 'node_modules'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies }));
  }
  return dir;
}

describe('update', () => {
  it('finds only the npx entries that hold our packages', () => {
    const cache = fakeCache({
      aaa: { isitdone: '^0.1.1' },
      bbb: { '@aivolution/isitdone': '^0.2.0' },
      ccc: { vitest: '^5.0.0' },
      ddd: { 'isitdone-something-else': '^1.0.0' },
    });
    expect(findNpxEntries(cache).map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['aaa', 'bbb']);
    expect(findNpxEntries(join(cache, 'missing'))).toEqual([]);
  });

  it('removes those entries without warming when asked', () => {
    const cache = fakeCache({ aaa: { isitdone: '^0.1.1' }, ccc: { vitest: '^5.0.0' } });
    const r = runUpdate({ cacheDir: cache, warm: false });
    expect(r.removed).toHaveLength(1);
    expect(existsSync(join(cache, '_npx', 'aaa'))).toBe(false);
    expect(existsSync(join(cache, '_npx', 'ccc'))).toBe(true);
    expect(r.warmed).toEqual([]);
    expect(r.running).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('check-only touches nothing', () => {
    const cache = fakeCache({ aaa: { isitdone: '^0.1.1' } });
    const r = runUpdate({ cacheDir: cache, warm: false, checkOnly: true });
    expect(r.removed).toEqual([]);
    expect(existsSync(join(cache, '_npx', 'aaa'))).toBe(true);
  });

  it('respects npm_config_cache and compares versions', () => {
    expect(npmCacheDir({ npm_config_cache: '/tmp/x' })).toBe('/tmp/x');
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.1')).toBe(false);
  });
});
