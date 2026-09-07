import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Strip a UTF-8 byte-order mark (PowerShell 5, Notepad and some editors add one). */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function readTextFile(file: string): string {
  return stripBom(readFileSync(file, 'utf8'));
}

/** Parse a JSON file, tolerating a BOM. Throws on invalid JSON. */
export function readJsonFile<T>(file: string): T {
  return JSON.parse(readTextFile(file)) as T;
}

/** Parse a JSON file; null if missing or invalid. */
export function tryReadJsonFile<T>(file: string): T | null {
  try {
    return readJsonFile<T>(file);
  } catch {
    return null;
  }
}

/** Write a file atomically (tmp + rename) so a concurrent reader never sees a torn file. */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content, mode !== undefined ? { encoding: 'utf8', mode } : { encoding: 'utf8' });
  try {
    renameSync(tmp, file);
  } catch {
    // Windows can refuse to replace a file that is momentarily open; fall back to a direct write.
    writeFileSync(file, content, { encoding: 'utf8' });
    rmSync(tmp, { force: true });
  }
}
