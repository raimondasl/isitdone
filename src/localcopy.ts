/**
 * A local copy of isitdone for hooks to run with plain `node`. Going through npx costs npm's own start-up on every hook
 * call (about 1.5 s on Windows, a few hundred ms elsewhere), and the edit hook runs after every file edit. isitdone is
 * one self-contained file, so the copy is that file, ~/.isitdone/bin/isitdone.js: `init --user` installs it and
 * registers `node "<copy>" hook ...`, `update` refreshes it, and doctor's probe proves it still answers.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECEIPT_DIR } from './git.js';
import { isNewer } from './update.js';
import { VERSION } from './version.js';

export function localCopyPath(): string | null {
  try {
    const home = homedir();
    return home ? join(home, RECEIPT_DIR, 'bin', 'isitdone.js') : null;
  } catch {
    return null;
  }
}

/** The bundle this process runs from, when it is the published single file (not a test or dev build). */
export function ownBundle(): string | null {
  try {
    const p = fileURLToPath(import.meta.url);
    return basename(p) === 'isitdone.js' && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** The version a bundle reports, or null when it does not run. */
export function bundleVersion(file: string): string | null {
  if (!existsSync(file)) return null;
  const r = spawnSync(process.execPath, [file, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, NO_COLOR: '1' } });
  return r.status === 0 ? (/(\d+\.\d+\.\d+\S*)\s*$/.exec((r.stdout ?? '').trim())?.[1] ?? null) : null;
}

export interface LocalCopyResult {
  path: string | null;
  version: string | null;
  action: 'installed' | 'updated' | 'unchanged' | 'unavailable';
  note: string | null;
}

/**
 * Puts `source` (default: this process's own bundle) at the local-copy path, unless the copy there is the same version or
 * newer: an older `npx isitdone@x` must not downgrade it.
 */
export function installLocalCopy(source: string | null = ownBundle(), sourceVersion: string = VERSION): LocalCopyResult {
  const path = localCopyPath();
  if (!path) return { path: null, version: null, action: 'unavailable', note: 'the home directory cannot be resolved' };
  if (!source) return { path, version: null, action: 'unavailable', note: 'this isitdone does not run from its published bundle, so there is nothing to copy' };
  // The path goes into a shell command line unescaped (the hosts run hook commands through a shell).
  if (/["$%`!]/.test(path)) return { path, version: null, action: 'unavailable', note: `${path} has a character that shells expand ($, %, !, \` or a quote)` };
  const dir = dirname(path);
  const installed = existsSync(path) ? bundleVersion(path) : null;
  if (installed && !isNewer(sourceVersion, installed)) return { path, version: installed, action: 'unchanged', note: null };
  // A hook whose file does not run fails open on most hosts, so the working copy is replaced only by a file that has
  // already answered: the new one is written beside it, run, and only then renamed over it. Never written in place.
  const tmp = join(dir, `isitdone.${process.pid}.${Date.now()}.tmp.js`);
  try {
    mkdirSync(dir, { recursive: true });
    // The bundle is an ES module; say so, rather than leave it to Node's guess (older Nodes do not guess, and a stray
    // package.json above it with "type": "commonjs" would break it).
    writeFileSync(join(dir, 'package.json'), '{\n  "type": "module"\n}\n');
    writeFileSync(tmp, readFileSync(source, 'utf8'));
    const answered = bundleVersion(tmp);
    if (answered !== sourceVersion) {
      rmSync(tmp, { force: true });
      return { path, version: installed, action: 'unavailable', note: `the new copy does not run here (it reported ${answered ?? 'nothing'}); ${installed ? `kept ${installed}` : 'nothing installed'}` };
    }
    renameWithRetry(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    return { path, version: installed, action: 'unavailable', note: `could not replace ${path}: ${(e as Error).message}${installed ? `; kept ${installed}` : ''}` };
  }
  return { path, version: sourceVersion, action: installed ? 'updated' : 'installed', note: null };
}

/** Windows refuses a rename over a file that is open for a moment (a hook starting, an antivirus scan): try again. */
function renameWithRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 5) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

/** The hook command that runs the local copy. Forward slashes: they work in cmd.exe, PowerShell and sh alike. */
export function directCommand(path: string, hostName: string): string {
  return `node "${path.replace(/\\/g, '/')}" hook --host ${hostName}`;
}

/** Does a registered command run the local copy (rather than npx or a custom wrapper)? */
export function runsLocalCopy(command: string): boolean {
  const path = localCopyPath();
  return path !== null && command.toLowerCase().includes(path.replace(/\\/g, '/').toLowerCase());
}
