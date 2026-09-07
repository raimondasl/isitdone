/**
 * Every test runs against a throwaway HOME so nothing can touch the developer's real
 * ~/.claude, ~/.codex, ~/.cursor or ~/.gemini settings. Spawned CLIs inherit it via process.env.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

let fakeHome: string | null = null;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'isitdone-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterAll(() => {
  if (fakeHome) {
    try {
      rmSync(fakeHome, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignore
    }
  }
});
