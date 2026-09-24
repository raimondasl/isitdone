#!/usr/bin/env node
/**
 * Test-integrity benchmark: precision and recall of the scanner over a labelled corpus.
 *
 *   npm run build && npm run bench            # summary tables
 *   node scripts/bench.mjs --verbose          # every miss
 *   node scripts/bench.mjs --json             # machine-readable
 *
 * Corpus: bench/cases/*.json, each an array of cases:
 *   { "id": "js-only-1", "kind": "tamper" | "legit", "language": "js" | "py" | "go" | "rust" | "java" | "csharp" | "config",
 *     "files": { "path": ["before or null", "after or null"] },   // identical before and after: context only, no diff
 *     "renames": { "new/path": "old/path" },                        // optional: "files" is keyed by the new path
 *     "expect": { "ids": ["only-added"] }            // tamper: at least one of these ids at medium+
 *     "note": "why this is legit / what the tamper is" }
 * A legit case passes when no finding of severity medium or higher is reported.
 * A tamper case passes when a finding with one of the expected ids (or, if none given, any finding)
 * of severity medium or higher is reported.
 *
 * Two recalls are reported. Per case: the share of tamper cases caught (the headline), with the exact counts. Per
 * detector: over the cases that name only detector X, the share in which X itself fired at medium or higher. A case
 * that names two ids accepts either (the tamper fits both), so it can pass on a sibling and says nothing about X alone;
 * those are counted in a separate column. Detectors that no case names are listed, low-severity ones as unscored.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { parseUnifiedDiff, scanIntegrity } from '../dist/index.js';

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');
const json = args.has('--json');
const dir = new URL('../bench/cases/', import.meta.url);
const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3 };

function diffFor(files, renames = {}) {
  let text = '';
  for (const [path, [before, after]] of Object.entries(files)) {
    if (before === null && after === null) continue;
    const from = renames[path] ?? path;
    if (before === after && from === path) continue; // unchanged: there to be read (a pom.xml, a config), not diffed
    const b = before === null ? [] : before.split('\n');
    const a = after === null ? [] : after.split('\n');
    const header = `diff --git a/${from} b/${path}\n${from !== path ? `rename from ${from}\nrename to ${path}\n` : ''}${before === null ? 'new file mode 100644\n' : ''}${after === null ? 'deleted file mode 100644\n' : ''}`;
    if (before === after) {
      text += header; // a pure rename: no hunks
      continue;
    }
    text += `${header}--- ${before === null ? '/dev/null' : 'a/' + from}\n+++ ${after === null ? '/dev/null' : 'b/' + path}\n@@ -1,${b.length} +1,${a.length} @@\n${[...b.map((l) => '-' + l), ...a.map((l) => '+' + l)].join('\n')}\n`;
  }
  return parseUnifiedDiff(text);
}

/** Every finding id the scanner can emit, with the severities its call sites use ('dynamic' when computed). */
function scannerIds() {
  const src = readFileSync(new URL('../src/integrity.ts', import.meta.url), 'utf8');
  const ids = new Map();
  for (const part of src.split("add(ctx, '").slice(1)) {
    const id = part.slice(0, part.indexOf("'"));
    const rest = part.slice(id.length + 1).trimStart().replace(/^,\s*/, '');
    const severity = rest.startsWith("'") ? rest.slice(1, rest.indexOf("'", 1)) : 'dynamic';
    if (!ids.has(id)) ids.set(id, new Set());
    ids.get(id).add(severity);
  }
  return ids;
}

function revision() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // not a checkout
  }
  return { version: pkg.version, commit };
}

const cases = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const list = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  for (const c of list) cases.push({ ...c, source: f });
}

const rows = [];
for (const c of cases) {
  const renames = c.renames ?? {};
  const oldToNew = Object.fromEntries(Object.entries(renames).map(([n, o]) => [o, n]));
  const report = scanIntegrity(diffFor(c.files, renames), {
    readBefore: (p) => (c.files[p] ?? c.files[oldToNew[p]])?.[0] ?? null,
    readAfter: (p) => c.files[p]?.[1] ?? null,
  });
  const medPlus = report.findings.filter((f) => SEVERITY[f.severity] <= SEVERITY.medium && !f.suppressed);
  const want = c.expect?.ids ?? [];
  let pass;
  if (c.kind === 'legit') pass = medPlus.length === 0;
  else pass = want.length === 0 ? medPlus.length > 0 : medPlus.some((f) => want.includes(f.id));
  rows.push({ id: c.id, kind: c.kind, language: c.language, pass, want, fired: [...new Set(medPlus.map((f) => f.id))], findings: report.findings.map((f) => `${f.id}:${f.severity}`), note: c.note, source: c.source });
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

const known = scannerIds();
const named = [...new Set(rows.flatMap((r) => r.want))].sort();
// A case that names one id measures that detector; a case that names two accepts either (the tamper fits both), so it
// says nothing about either detector alone and is counted apart.
const byDetector = named.map((id) => {
  const sole = rows.filter((x) => x.kind === 'tamper' && x.want.length === 1 && x.want[0] === id);
  const shared = rows.filter((x) => x.kind === 'tamper' && x.want.length > 1 && x.want.includes(id));
  const fired = sole.filter((x) => x.fired.includes(id)).length;
  return { id, cases: sole.length, fired, recall: sole.length ? fired / sole.length : null, notFired: sole.filter((x) => !x.fired.includes(id)).map((x) => x.id), shared: shared.length, sharedFired: shared.filter((x) => x.fired.includes(id)).length };
});
const unnamed = [...known.keys()]
  .filter((id) => !named.includes(id))
  .sort()
  .map((id) => ({ id, severities: [...known.get(id)], informational: [...known.get(id)].every((s) => s === 'low') }));
const rev = revision();
const summary = { revision: rev, total: by(null), byLanguage: langs.map(by), byDetector, unnamed, misses: rows.filter((r) => !r.pass) };

if (json) {
  console.log(JSON.stringify({ ...summary, rows: verbose ? rows : undefined }, null, 2));
} else {
  const pct = (v) => (v === null ? '  -  ' : `${Math.round(v * 100)}%`.padStart(5));
  const t = summary.total;
  console.log(`isitdone bench   ${cases.length} labelled cases from bench/cases/   (isitdone ${rev.version}${rev.commit ? `, commit ${rev.commit}` : ''})`);
  console.log('');
  console.log('  language   cases  tamper  legit   caught  missed  false+   precision  recall');
  for (const s of [...summary.byLanguage, t]) {
    console.log(`  ${s.language.padEnd(10)} ${String(s.cases).padStart(5)}  ${String(s.tamper).padStart(6)}  ${String(s.legit).padStart(5)}   ${String(s.tp).padStart(6)}  ${String(s.fn).padStart(6)}  ${String(s.fp).padStart(6)}   ${pct(s.precision)}      ${pct(s.recall)}`);
  }
  console.log(`  exact: precision ${t.tp}/${t.tp + t.fp}, recall ${t.tp}/${t.tp + t.fn} (per case)`);
  console.log('');
  console.log('  detector                 cases  fired   recall   (cases naming only this id; it fired at medium+)   two-id cases (fired)');
  for (const d of byDetector) {
    console.log(`  ${d.id.padEnd(24)} ${String(d.cases).padStart(5)}  ${String(d.fired).padStart(5)}   ${pct(d.recall)}   ${d.shared ? `${String(d.shared).padStart(3)} (${d.sharedFired})` : '   '}${d.cases < 3 ? '   thin: fewer than 3 cases' : ''}${verbose && d.notFired.length ? `   not fired in ${d.notFired.join(', ')}` : ''}`);
  }
  if (unnamed.length) {
    console.log('');
    console.log(`  no case names: ${unnamed.map((u) => `${u.id}${u.informational ? ' (low severity: informational, never scored)' : ''}`).join(', ')}`);
  }
  console.log('');
  if (summary.misses.length === 0) console.log('  no misses');
  else {
    console.log(`  ${summary.misses.length} miss${summary.misses.length === 1 ? '' : 'es'}${verbose ? '' : ' (--verbose for details)'}`);
    if (verbose) for (const m of summary.misses) console.log(`  ${m.kind === 'legit' ? 'FALSE+' : 'MISSED'}  ${m.id.padEnd(28)} ${(m.findings.join(', ') || '(no findings)').padEnd(50)} ${m.note ?? ''}`);
  }
  console.log('');
  console.log('  precision = caught / (caught + false positives); recall = caught / (caught + missed). Every case is synthetic and labelled by hand;');
  console.log('  add a case to bench/cases/ whenever the scanner is wrong on real code. Quote results with the version and commit above.');
}
process.exitCode = 0;
