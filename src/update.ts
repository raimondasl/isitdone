/**
 * `isitdone update`: npx keeps its own install cache (_npx/<hash>/) that `npm cache clean` does not touch,
 * so an unpinned `npx -y @aivolution/isitdone hook ...` can keep running the first version it cached.
 * This removes those entries for our packages and re-warms them at the registry's latest.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryReadJsonFile } from './fsutil.js';
import { PACKAGE_NAME } from './init.js';
import { VERSION } from './version.js';

export const OUR_PACKAGES = [PACKAGE_NAME, 'isitdone'];

export interface UpdateResult {
  cacheDir: string | null;
  removed: string[];
  warmed: Array<{ pkg: string; version: string | null; error: string | null }>;
  latest: string | null;
  running: string;
}

function npm(args: string[], timeoutMs = 20_000): { ok: boolean; out: string } {
  // One command string through the shell: npm is a .cmd shim on Windows, and Node warns about args arrays with shell:true.
  const r = spawnSync(`npm ${args.join(' ')}`, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, shell: true, cwd: tmpdir() });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** npm's cache directory (respects npm_config_cache), or null if npm is unavailable. */
export function npmCacheDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.npm_config_cache) return env.npm_config_cache;
  const r = npm(['config', 'get', 'cache']);
  if (r.ok && r.out && r.out !== 'undefined') return r.out;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'npm-cache');
  return join(homedir(), '.npm');
}

/** _npx entries whose dependencies include one of our packages. */
export function findNpxEntries(cacheDir: string, packages = OUR_PACKAGES): string[] {
  const npx = join(cacheDir, '_npx');
  if (!existsSync(npx)) return [];
  const out: string[] = [];
  for (const e of readdirSync(npx)) {
    const dir = join(npx, e);
    const pkg = tryReadJsonFile<{ dependencies?: Record<string, string> }>(join(dir, 'package.json'));
    const deps = Object.keys(pkg?.dependencies ?? {});
    if (deps.some((d) => packages.includes(d))) out.push(dir);
  }
  return out;
}

/** The registry's latest version of the canonical package, or null when offline. */
export function latestVersion(timeoutMs = 8000): string | null {
  const r = npm(['view', PACKAGE_NAME, 'version'], timeoutMs);
  return r.ok && /^\d+\.\d+\.\d+/.test(r.out) ? r.out : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function runUpdate(opts: { warm?: boolean; cacheDir?: string | null; checkOnly?: boolean } = {}): UpdateResult {
  const cacheDir = opts.cacheDir === undefined ? npmCacheDir() : opts.cacheDir;
  const result: UpdateResult = { cacheDir, removed: [], warmed: [], latest: latestVersion(), running: VERSION };
  if (opts.checkOnly) return result;
  if (cacheDir) {
    for (const dir of findNpxEntries(cacheDir)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        result.removed.push(dir);
      } catch {
        // leave it; the warm step will still create a fresh entry if it can
      }
    }
  }
  if (opts.warm ?? true) {
    for (const pkg of OUR_PACKAGES) {
      // From a neutral directory: inside a project, npx would prefer that project's own bins over the registry package.
      const r = spawnSync(`npx -y ${pkg} --version`, { encoding: 'utf8', shell: true, windowsHide: true, timeout: 120_000, cwd: tmpdir(), env: { ...process.env, NO_COLOR: '1' } });
      const version = /(\d+\.\d+\.\d+)\s*$/.exec((r.stdout ?? '').trim())?.[1] ?? null;
      result.warmed.push({ pkg, version, error: r.status === 0 && version ? null : (r.stderr ?? '').trim().split('\n').slice(-1)[0] || 'npx failed' });
    }
  }
  return result;
}
