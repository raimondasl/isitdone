#!/usr/bin/env node
/**
 * Test-integrity benchmark: precision and recall of the scanner over a labelled corpus.
 *
 *   npm run build && npm run bench            # summary table
 *   node scripts/bench.mjs --verbose          # every miss
 *   node scripts/bench.mjs --json             # machine-readable
 *
 * Corpus: bench/cases/*.json, each an array of cases:
 *   { "id": "js-only-1", "kind": "tamper" | "legit", "language": "js" | "py" | "go" | "rust" | "java" | "csharp" | "config",
 *     "files": { "path": ["before or null", "after or null"] },
 *     "expect": { "ids": ["only-added"] }            // tamper: at least one of these ids at medium+
 *     "note": "why this is legit / what the tamper is" }
 * A legit case passes when no finding of severity medium or higher is reported.
 * A tamper case passes when a finding with one of the expected ids (or, if none given, any finding)
 * of severity medium or higher is reported.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUnifiedDiff, scanIntegrity } from '../dist/index.js';

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');
const json = args.has('--json');
const dir = new URL('../bench/cases/', import.meta.url);
const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3 };

function diffFor(files) {
  let text = '';
  for (const [path, [before, after]] of Object.entries(files)) {
    if (before === null && after === null) continue;
    const b = before === null ? [] : before.split('\n');
    const a = after === null ? [] : after.split('\n');
    text += `diff --git a/${path} b/${path}\n${before === null ? 'new file mode 100644\n' : ''}${after === null ? 'deleted file mode 100644\n' : ''}--- ${before === null ? '/dev/null' : 'a/' + path}\n+++ ${after === null ? '/dev/null' : 'b/' + path}\n@@ -1,${b.length} +1,${a.length} @@\n${[...b.map((l) => '-' + l), ...a.map((l) => '+' + l)].join('\n')}\n`;
  }
  return parseUnifiedDiff(text);
}

const cases = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const list = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  for (const c of list) cases.push({ ...c, source: f });
}

const rows = [];
for (const c of cases) {
  const report = scanIntegrity(diffFor(c.files), { readBefore: (p) => c.files[p]?.[0] ?? null, readAfter: (p) => c.files[p]?.[1] ?? null });
  const medPlus = report.findings.filter((f) => SEVERITY[f.severity] <= SEVERITY.medium && !f.suppressed);
  let pass;
  if (c.kind === 'legit') pass = medPlus.length === 0;
  else {
    const want = c.expect?.ids ?? [];
    pass = want.length === 0 ? medPlus.length > 0 : medPlus.some((f) => want.includes(f.id));
  }
  rows.push({ id: c.id, kind: c.kind, language: c.language, pass, findings: report.findings.map((f) => `${f.id}:${f.severity}`), note: c.note, source: c.source });
}

const by = (lang) => {
  const r = rows.filter((x) => !lang || x.language === lang);
  const tamper = r.filter((x) => x.kind === 'tamper');
  const legit = r.filter((x) => x.kind === 'legit');
  const tp = tamper.filter((x) => x.pass).length;
  const fn = tamper.length - tp;
  const fp = legit.filter((x) => !x.pass).length;
  const tn = legit.length - fp;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  return { language: lang ?? 'all', cases: r.length, tamper: tamper.length, legit: legit.length, tp, fp, fn, tn, precision, recall };
};
const langs = [...new Set(rows.map((r) => r.language))].sort();
const summary = { total: by(null), byLanguage: langs.map(by), misses: rows.filter((r) => !r.pass) };

if (json) {
  console.log(JSON.stringify({ ...summary, rows: verbose ? rows : undefined }, null, 2));
} else {
  const pct = (v) => (v === null ? '  -  ' : `${Math.round(v * 100)}%`.padStart(5));
  console.log(`isitdone bench   ${cases.length} labelled cases from bench/cases/`);
  console.log('');
  console.log('  language   cases  tamper  legit   caught  missed  false+   precision  recall');
  for (const s of [...summary.byLanguage, summary.total]) {
    console.log(`  ${s.language.padEnd(10)} ${String(s.cases).padStart(5)}  ${String(s.tamper).padStart(6)}  ${String(s.legit).padStart(5)}   ${String(s.tp).padStart(6)}  ${String(s.fn).padStart(6)}  ${String(s.fp).padStart(6)}   ${pct(s.precision)}      ${pct(s.recall)}`);
  }
  console.log('');
  if (summary.misses.length === 0) console.log('  no misses');
  else {
    console.log(`  ${summary.misses.length} miss${summary.misses.length === 1 ? '' : 'es'}${verbose ? '' : ' (--verbose for details)'}`);
    if (verbose) for (const m of summary.misses) console.log(`  ${m.kind === 'legit' ? 'FALSE+' : 'MISSED'}  ${m.id.padEnd(28)} ${(m.findings.join(', ') || '(no findings)').padEnd(50)} ${m.note ?? ''}`);
  }
  console.log('');
  console.log('  precision = caught / (caught + false positives); recall = caught / (caught + missed). Every case is synthetic and labelled by hand;');
  console.log('  add a case to bench/cases/ whenever the scanner is wrong on real code.');
}
process.exitCode = 0;
