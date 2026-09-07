/**
 * Warn-only check after the agent edits a file: scan just that file against HEAD (or a base ref)
 * and produce a short note the agent can read mid-turn. Never blocks; a scan failure yields nothing.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { collectDiff, readAtBase, readNow } from './diff.js';
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

export function toRepoPath(top: string, file: string): string {
  let abs = isAbsolute(file) ? file : resolve(top, file);
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

/** Scan one edited file. `file` may be absolute or relative to `cwd`. */
export function checkEditedFile(cwd: string, file: string, base = 'HEAD'): EditCheck | null {
  const top = gitTopLevel(cwd);
  if (!top) return null;
  const path = toRepoPath(top, file);
  if (path.startsWith('..')) return null;
  if (!isTestFile(path) && !isTestConfigFile(path)) return { path, report: null, notable: [], note: null };
  const diff = collectDiff(top, base);
  if (diff.error) return null;
  const files = diff.files.filter((f) => f.path === path || f.oldPath === path);
  if (files.length === 0) return { path, report: null, notable: [], note: null };
  const report = scanIntegrity(files, { readBefore: (p) => readAtBase(top, p, base), readAfter: (p) => readNow(top, p) });
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const notable = report.findings.filter((f) => !f.suppressed && order[f.severity] <= order.medium);
  return { path, report, notable, note: formatEditNote(path, report, notable) };
}

export function formatEditNote(path: string, report: IntegrityReport, notable: Finding[]): string | null {
  if (notable.length === 0) return null;
  const lines: string[] = [];
  const s = report.summary;
  const counts = report.testFiles > 0 ? ` (${formatSummaryLine(s)})` : '';
  lines.push(`isitdone: your edit to ${path} weakened the tests${counts}:`);
  for (const f of notable.slice(0, 5)) lines.push(`  - ${f.line ? `line ${f.line}: ` : ''}${f.message} [${f.severity}]`);
  if (notable.length > 5) lines.push(`  - ... ${notable.length - 5} more`);
  lines.push('If this is intentional, say so to the user and explain why; otherwise restore the tests. The Stop hook will run the full checks before you can finish.');
  return lines.join('\n');
}
