/**
 * Warn-only check after the agent edits a file: scan just that file against HEAD (or a base ref)
 * and produce a short note the agent can read mid-turn. Never blocks; a scan failure yields nothing.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { collectDiff, readAtBase, readNow, type DiffFile, type DiffResult } from './diff.js';
import { gitTopLevel } from './git.js';
import { formatSummaryLine, isTestConfigFile, isTestFile, scanIntegrity, type Finding, type IntegrityReport } from './integrity.js';

export interface EditCheck {
  /** Repo-relative path that was checked. */
  path: string;
  /** Null when the file is neither a test file nor a test configuration file. */
  report: IntegrityReport | null;
  /** Findings for this file at medium severity or above, unsuppressed. */
  notable: Finding[];
  /** One-paragraph note for the agent, or null when there is nothing worth saying. */
  note: string | null;
}

/** Repo-relative form of `file`. A relative `file` is resolved against `cwd` (the host's session directory), not the top-level. */
export function toRepoPath(top: string, file: string, cwd: string = top): string {
  let abs = isAbsolute(file) ? file : resolve(cwd, file);
  // Canonical long-name form (Windows 8.3 short names, symlinks); a deleted file canonicalises its parent.
  try {
    abs = realpathSync.native(abs);
  } catch {
    try {
      abs = join(realpathSync.native(dirname(abs)), basename(abs));
    } catch {
      // keep as resolved
    }
  }
  let base = top;
  try {
    base = realpathSync.native(top);
  } catch {
    // keep as given
  }
  return relative(base, abs).replace(/\\/g, '/');
}

/** `relative()` yields ".." outside the repo, or (Windows, another drive or a UNC share) an absolute path. */
function insideRepo(path: string): boolean {
  return path !== '' && !path.startsWith('..') && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !path.startsWith('//');
}

const isScannable = (p: string) => isTestFile(p) || isTestConfigFile(p);

/**
 * Scan one edited file. `file` may be absolute or relative to `cwd`. `diff` supplies the working-tree diff (taken
 * lazily, so a hook run that touches several files diffs once and a non-test file costs nothing).
 */
export function checkEditedFile(cwd: string, file: string, base = 'HEAD', diff?: () => DiffResult): EditCheck | null {
  const top = gitTopLevel(cwd);
  if (!top) return null;
  const path = toRepoPath(top, file, cwd);
  if (!insideRepo(path)) return null;
  if (!isScannable(path)) return { path, report: null, notable: [], note: null };
  const d = diff ? diff() : collectDiff(top, base);
  if (d.error) return null;
  const mine = d.files.filter((f) => f.path === path || f.oldPath === path);
  if (mine.length === 0) return { path, report: null, notable: [], note: null };
  // An unstaged rename is a deleted file plus an untracked one; give the scanner both sides so it can pair them.
  const others = (status: DiffFile['status']) => d.files.filter((f) => f.status === status && !mine.includes(f) && isScannable(f.path));
  const files = [...mine, ...(mine.some((f) => f.status === 'deleted') ? others('added') : []), ...(mine.some((f) => f.status === 'added') ? others('deleted') : [])];
  const report = scanIntegrity(files, { readBefore: (p) => readAtBase(top, p, base), readAfter: (p) => readNow(top, p) });
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const notable = report.findings.filter((f) => !f.suppressed && order[f.severity] <= order.medium && mine.some((m) => m.path === f.file));
  return { path, report, notable, note: formatEditNote(path, report, notable) };
}

export function formatEditNote(path: string, report: IntegrityReport, notable: Finding[]): string | null {
  if (notable.length === 0) return null;
  const lines: string[] = [];
  const s = report.summary;
  const counts = report.testFiles > 0 ? ` (${formatSummaryLine(s)})` : '';
  // The scan is working tree vs HEAD: it sees every uncommitted change to this file, not only the lines just edited.
  lines.push(`isitdone: after your edit, ${path} has weaker tests than HEAD${counts}:`);
  for (const f of notable.slice(0, 5)) lines.push(`  - ${f.line ? `line ${f.line}: ` : ''}${f.message} [${f.severity}]`);
  if (notable.length > 5) lines.push(`  - ... ${notable.length - 5} more`);
  lines.push('If this is intentional, or the change was already there before your edit, tell the user why; otherwise restore the tests. The Stop hook will run the full checks before you can finish.');
  return lines.join('\n');
}
