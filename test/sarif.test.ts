import { describe, expect, it } from 'vitest';
import { toSarif } from '../src/sarif.js';
import type { IntegrityReport } from '../src/integrity.js';

describe('toSarif', () => {
  it('produces a SARIF 2.1.0 document with rules, levels and locations', () => {
    const report: IntegrityReport = {
      findings: [
        { id: 'only-added', severity: 'critical', file: 'src\\a.test.ts', line: 4, message: '`.only` added', evidence: "it.only('x')", suppressed: null },
        { id: 'assertion-weakened', severity: 'medium', file: 'src/a.test.ts', line: 9, message: 'weakened', evidence: '- a\n+ b', suppressed: null },
        { id: 'skip-added', severity: 'high', file: 'src/b.test.ts', line: 2, message: 'skipped', evidence: 'it.skip', suppressed: 'flaky upstream' },
        { id: 'tests-removed', severity: 'high', file: 'src/c.test.ts', line: null, message: 'dropped', evidence: '', suppressed: null },
      ],
      summary: { testsBefore: 3, testsAfter: 2, assertionsBefore: 3, assertionsAfter: 2, skippedBefore: 0, skippedAfter: 1 },
      files: 3,
      testFiles: 3,
      blocking: [],
    };
    const doc = toSarif(report, { base: 'main' }) as { version: string; runs: Array<{ tool: { driver: { rules: Array<{ id: string }> } }; results: Array<Record<string, unknown>>; properties: Record<string, unknown> }> };
    expect(doc.version).toBe('2.1.0');
    const run = doc.runs[0]!;
    expect(run.tool.driver.rules.map((r) => r.id).sort()).toEqual(['assertion-weakened', 'only-added', 'skip-added', 'tests-removed']);
    expect(run.results.map((r) => r.level)).toEqual(['error', 'warning', 'note', 'error']);
    const first = run.results[0] as { locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }> };
    expect(first.locations[0]?.physicalLocation.artifactLocation.uri).toBe('src/a.test.ts');
    expect(first.locations[0]?.physicalLocation.region?.startLine).toBe(4);
    const last = run.results[3] as { locations: Array<{ physicalLocation: { region?: unknown } }> };
    expect(last.locations[0]?.physicalLocation.region).toBeUndefined();
    expect(run.properties.base).toBe('main');
    expect(JSON.stringify(doc)).toContain('allowed: flaky upstream');
  });
});
