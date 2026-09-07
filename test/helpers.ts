import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  root: string;
  write(file: string, content: string): void;
  git(...args: string[]): string;
  commit(message?: string): string;
  cleanup(): void;
}

/** A throwaway directory, optionally initialised as a git repo with one commit. */
export function tempRepo(opts: { git?: boolean; files?: Record<string, string> } = {}): TempRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'isitdone-test-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  const write = (file: string, content: string) => {
    const p = join(root, file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const commit = (message = 'commit') => {
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  for (const [f, c] of Object.entries(opts.files ?? {})) write(f, c);
  if (opts.git !== false) {
    git('init', '-q', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    if (opts.files && Object.keys(opts.files).length > 0) commit('init');
  }
  return {
    root,
    write,
    git,
    commit,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Windows may hold handles briefly; ignore
      }
    },
  };
}

/** A package.json whose scripts are portable node one-liners. */
export function nodePkg(scripts: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'fixture', version: '0.0.0', private: true, scripts, ...extra }, null, 2);
}

export const PASS = 'node -e "process.exit(0)"';
export const FAIL = 'node -e "console.log(\'1 failed, 2 passed\'); process.exit(1)"';
export const SLOW = 'node -e "setTimeout(function(){}, 20000)"';
