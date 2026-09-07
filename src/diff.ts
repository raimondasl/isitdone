import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPT_DIR } from './git.js';

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffLine {
  kind: '+' | '-' | ' ';
  text: string;
  /** Line number in the new file (null for removed lines). */
  newNo: number | null;
  /** Line number in the old file (null for added lines). */
  oldNo: number | null;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

export interface DiffResult {
  files: DiffFile[];
  /** What the diff was taken against (HEAD or a base ref). */
  base: string;
  error: string | null;
}

const MAX_SYNTH_BYTES = 2 * 1024 * 1024;

/** Parse `git diff` unified output into files and hunks. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let cur: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
      cur = { path: m ? unquote(m[2] as string) : line.slice(11), oldPath: m ? unquote(m[1] as string) : null, status: 'modified', binary: false, hunks: [] };
      if (cur.oldPath === cur.path) cur.oldPath = null;
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      cur.status = 'renamed';
      cur.oldPath = unquote(line.slice(12));
    } else if (line.startsWith('rename to ')) cur.path = unquote(line.slice(10));
    else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) cur.binary = true;
    else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // headers; path already known
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { oldStart: oldNo, newStart: newNo, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith('+')) hunk.lines.push({ kind: '+', text: line.slice(1), newNo: newNo++, oldNo: null });
      else if (line.startsWith('-')) hunk.lines.push({ kind: '-', text: line.slice(1), newNo: null, oldNo: oldNo++ });
      else if (line.startsWith(' ') || line === '') hunk.lines.push({ kind: ' ', text: line.slice(1), newNo: newNo++, oldNo: oldNo++ });
      // "\ No newline at end of file" and anything else: ignore
    }
  }
  return files;
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { ok: false, out: '', err: r.error.message };
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

/** Synthesize an "added" diff for an untracked file so new test files are scanned too. */
function synthAdded(top: string, rel: string): DiffFile | null {
  const abs = join(top, rel);
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_SYNTH_BYTES) return null;
    const content = readFileSync(abs, 'utf8');
    if (content.includes('\0')) return { path: rel, oldPath: null, status: 'added', binary: true, hunks: [] };
    const lines = content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return {
      path: rel,
      oldPath: null,
      status: 'added',
      binary: false,
      hunks: [{ oldStart: 0, newStart: 1, lines: lines.map((text, i) => ({ kind: '+' as const, text: text.replace(/\r$/, ''), newNo: i + 1, oldNo: null })) }],
    };
  } catch {
    return null;
  }
}

/**
 * The change set to scan: working tree (staged + unstaged + untracked) against HEAD, or against `base`.
 */
export function collectDiff(top: string, base = 'HEAD'): DiffResult {
  const exclude = `:(exclude)${RECEIPT_DIR}`;
  const hasHead = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], top).ok;
  // Only HEAD may be absent (a repository with no commits yet); an explicit base that does not resolve is an error,
  // not "everything is new".
  if (!hasHead && base !== 'HEAD') return { files: [], base, error: `base ${base} not found` };
  let files: DiffFile[] = [];
  if (hasHead) {
    // core.quotePath=false keeps non-ASCII paths readable instead of octal-escaped.
    const d = git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U3', '-M', base, '--', '.', exclude], top);
    if (!d.ok) return { files: [], base, error: `git diff failed: ${d.err}` };
    files = parseUnifiedDiff(d.out);
  }
  // Untracked files are new; with no commit yet, staged files are new too.
  const others = git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--exclude-standard', ...(hasHead ? [] : ['--cached']), '--', '.', exclude], top);
  if (others.ok) {
    for (const rel of others.out.split('\0').filter(Boolean)) {
      if (files.some((f) => f.path === rel)) continue;
      const synth = synthAdded(top, rel);
      if (synth) files.push(synth);
    }
  }
  return { files, base, error: null };
}

/** File content at the base ref, or null when it did not exist. */
export function readAtBase(top: string, path: string, base = 'HEAD'): string | null {
  const r = spawnSync('git', ['show', `${base}:${path}`], { cwd: top, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout ?? '') : null;
}

/** Current working-tree content, or null when the file is gone. */
export function readNow(top: string, path: string): string | null {
  const abs = join(top, path);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
