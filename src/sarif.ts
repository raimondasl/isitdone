/** SARIF 2.1.0 output for test-integrity findings (GitHub code scanning, IDEs). */
import type { Finding, IntegrityReport, Severity } from './integrity.js';
import { VERSION } from './version.js';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };

const RULES: Record<string, string> = {
  'only-added': 'A .only/fit/fdescribe was added; every other test in the file is skipped',
  'skip-added': 'A test was skipped or marked as expected failure',
  'todo-added': 'A todo placeholder was added',
  'tautology-added': 'An assertion that can never fail was added',
  'early-return-added': 'A return was added before the assertions; the rest of the test never runs',
  'assertion-weakened': 'An assertion was replaced by a weaker one',
  'tolerance-widened': 'A numeric tolerance was widened',
  'error-swallowed': 'Errors are swallowed inside a test',
  'tests-removed': 'The number of tests in a file dropped',
  'tests-moved': 'Tests moved to another file',
  'assertions-removed': 'The number of assertions in a file dropped',
  'test-file-deleted': 'A test file was deleted or moved out of the test locations',
  'config-weakened': 'Test or CI configuration was weakened',
  'test-step-removed': 'A test command was removed from configuration',
  'ci-workflow-deleted': 'A CI workflow was deleted',
  'snapshot-changed': 'A snapshot file changed',
  'suppression-added': 'An isitdone suppression was added',
};

export function toSarif(report: IntegrityReport, opts: { base?: string } = {}): Record<string, unknown> {
  const used = [...new Set(report.findings.map((f) => f.id))];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'isitdone',
            version: VERSION,
            informationUri: 'https://github.com/raimondasl/isitdone',
            rules: used.map((id) => ({
              id,
              name: id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
              shortDescription: { text: RULES[id] ?? id },
              helpUri: 'https://github.com/raimondasl/isitdone#how-it-decides',
              properties: { tags: ['test-integrity'] },
            })),
          },
        },
        properties: { base: opts.base ?? 'HEAD', summary: report.summary },
        results: report.findings.map((f: Finding) => ({
          ruleId: f.id,
          level: f.suppressed ? 'note' : LEVEL[f.severity],
          message: { text: `${f.message}${f.suppressed ? ` (allowed: ${f.suppressed})` : ''}${f.evidence ? `\n${f.evidence}` : ''}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file.replace(/\\/g, '/'), uriBaseId: '%SRCROOT%' },
                ...(f.line ? { region: { startLine: f.line } } : {}),
              },
            },
          ],
          properties: { severity: f.severity, suppressed: f.suppressed ?? null },
        })),
      },
    ],
  };
}
