#!/usr/bin/env node
/**
 * Render docs/demo.svg (and docs/demo.txt) from a REAL run of the built CLI.
 *
 *  1. builds dist/ if it is missing
 *  2. creates a throwaway git repo with a tiny node project whose tests fail
 *  3. step A: feeds a Claude Code Stop payload to `isitdone hook --host claude` and captures the block reason
 *  4. step B: fixes the bug, runs `isitdone --no-cache` with colours on and captures the receipt output
 *  5. writes an animated (SMIL-only, no JavaScript) terminal SVG for the README
 *
 * The agent lines in the SVG are narration; the hook reason and CLI output are the captured text.
 * The only edit made to the captured text is that the random temp directory is replaced by /tmp/demo-app.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const dist = join(repoRoot, 'dist', 'isitdone.js');
const docsDir = join(repoRoot, 'docs');
const svgPath = join(docsDir, 'demo.svg');
const txtPath = join(docsDir, 'demo.txt');

const CLAIM = 'Done. I implemented the discount and all tests pass.';
const FIX_NARRATION = 'Fixing the discount order in src/price.mjs …';
const PLACEHOLDER = '/tmp/demo-app';

// ---------------------------------------------------------------------------------------------------------------------
// ANSI helpers

const ESC = String.fromCharCode(27);
const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');
const OTHER_ESC_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[^\\[]`, 'g');

function stripAnsi(s) {
  return s.replace(SGR_RE, '').replace(OTHER_ESC_RE, '');
}

const FG = {
  30: 'dim', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'dim', 91: 'red', 92: 'green', 93: 'yellow', 94: 'blue', 95: 'magenta', 96: 'cyan', 97: 'white',
};

/** One line of ANSI text -> [{ text, fg, bold, dim }]. Unknown SGR codes are ignored; other escapes are dropped. */
function parseAnsiLine(line) {
  const segs = [];
  const state = { fg: null, bold: false, dim: false };
  let last = 0;
  const push = (text) => {
    if (text !== '') segs.push({ text, ...state });
  };
  for (const m of line.matchAll(SGR_RE)) {
    push(stripAnsi(line.slice(last, m.index)));
    last = m.index + m[0].length;
    const codes = (m[1] === '' ? '0' : m[1]).split(';').map((c) => Number(c));
    for (const c of codes) {
      if (c === 0) Object.assign(state, { fg: null, bold: false, dim: false });
      else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 22) Object.assign(state, { bold: false, dim: false });
      else if (c === 39) state.fg = null;
      else if (FG[c]) state.fg = FG[c];
    }
  }
  push(stripAnsi(line.slice(last)));
  return segs;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. build if needed

if (!existsSync(dist)) {
  console.log('dist/isitdone.js missing; building');
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], { cwd: repoRoot, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. throwaway project

const PACKAGE_JSON = `{ "name": "demo-app", "scripts": { "test": "node --test" } }\n`;

const PRICE_INITIAL = `export function total(items, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return round(subtotal * (1 + taxRate));
}

function round(n) {
  return Math.round(n * 100) / 100;
}
`;

// The agent's edit: the discount is applied AFTER tax, so a 5.00 discount is worth 5.00 instead of 6.00.
const PRICE_BUGGY = `export function total(items, taxRate, discount = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const taxed = subtotal * (1 + taxRate);
  return round(taxed - discount);
}

function round(n) {
  return Math.round(n * 100) / 100;
}
`;

const PRICE_FIXED = `export function total(items, taxRate, discount = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const discounted = Math.max(0, subtotal - discount);
  return round(discounted * (1 + taxRate));
}

function round(n) {
  return Math.round(n * 100) / 100;
}
`;

const PRICE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/price.mjs';

const cart = [{ price: 10, qty: 2 }, { price: 5.5, qty: 1 }];

test('sums the cart and applies tax', () => {
  assert.equal(total(cart, 0.2), 30.6);
});

test('rounds to cents', () => {
  assert.equal(total([{ price: 0.1, qty: 3 }], 0), 0.3);
});

test('discount is taken off before tax', () => {
  assert.equal(total(cart, 0.2, 5), 24.6);
});
`;

function write(root, file, content) {
  const p = join(root, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'isitdone-demo-')));
console.log(`temp repo: ${repo}`);

/** Environment for the CLI runs: never inherit a nested-run marker or a colour override. */
function cliEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['ISITDONE', 'ISITDONE_DOCTOR', 'ISITDONE_DEBUG', 'NO_COLOR', 'FORCE_COLOR']) delete env[k];
  return { ...env, ...extra };
}

function runCli(args, opts) {
  const r = spawnSync(process.execPath, [dist, ...args], {
    cwd: repo,
    encoding: 'utf8',
    input: opts.input,
    env: opts.env,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r;
}

/** Replace the random temp directory (either slash style, either case on Windows) with a stable placeholder. */
function neutralise(text) {
  const fwd = repo.replace(/\\/g, '/');
  const back = repo.replace(/\//g, '\\');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  return text
    .replace(new RegExp('file:///' + escapeRe(fwd), flags), 'file://' + PLACEHOLDER)
    .replace(new RegExp(escapeRe(fwd), flags), PLACEHOLDER)
    .replace(new RegExp(escapeRe(back), flags), PLACEHOLDER);
}

let reason;
let cliAnsi;
try {
  write(repo, 'package.json', PACKAGE_JSON);
  write(repo, 'src/price.mjs', PRICE_INITIAL);
  write(repo, 'test/price.test.mjs', PRICE_TEST);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Add price module; discount test is still red');

  // The agent's turn: it adds the discount, gets the order wrong, and says "done".
  write(repo, 'src/price.mjs', PRICE_BUGGY);

  // -------------------------------------------------------------------------------------------------------------------
  // 3. step A: the Stop hook

  const payload = {
    session_id: 'demo',
    transcript_path: null,
    cwd: repo,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    permission_mode: 'default',
    last_assistant_message: CLAIM,
  };
  const a = runCli(['hook', '--host', 'claude'], { input: JSON.stringify(payload), env: cliEnv() });
  if (a.status !== 0) throw new Error(`step A: hook exited ${a.status}\n${a.stderr}`);
  let decision;
  try {
    decision = JSON.parse(a.stdout.trim());
  } catch {
    throw new Error(`step A: hook stdout is not JSON:\n${a.stdout}\n${a.stderr}`);
  }
  if (decision.decision !== 'block' || typeof decision.reason !== 'string') {
    throw new Error(`step A: expected a block decision, got ${a.stdout}\n${a.stderr}`);
  }
  reason = neutralise(decision.reason);

  // -------------------------------------------------------------------------------------------------------------------
  // 4. step B: the fix, then `npx isitdone`

  write(repo, 'src/price.mjs', PRICE_FIXED);
  const b = runCli(['--no-cache'], { env: cliEnv({ FORCE_COLOR: '1' }) });
  if (b.status !== 0) throw new Error(`step B: isitdone exited ${b.status}\n${stripAnsi(b.stdout)}\n${b.stderr}`);
  cliAnsi = neutralise(b.stdout.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
} finally {
  cleanup(repo);
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. the SVG

const COLS = 100;
const WIDTH = 880;
const PAD = 16;
const TITLE_H = 36;
const LINE_H = 20;
const LOOP_S = 22;
/** Reason lines shown before the "…" line (the final instruction line is kept after it). */
const REASON_CAP = 13;

const COLOR = {
  text: '#e5e7eb',
  dim: '#9ca3af',
  green: '#4ade80',
  red: '#f87171',
  yellow: '#fbbf24',
  cyan: '#67e8f9',
  magenta: '#f0abfc',
  blue: '#93c5fd',
  white: '#f9fafb',
  prompt: '#c4b5fd',
};

const NBSP = String.fromCharCode(160);

/** XML-escape text and turn spaces into no-break spaces so runs of spaces survive renderers that ignore xml:space. */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, NBSP);
}

/** Split a plain string into segments, styling every match of `re` with `hit` on top of `base`. */
function highlight(text, re, hit, base = {}) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), ...base });
    out.push({ text: m[0], ...base, ...hit });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), ...base });
  return out;
}

/** Wrap a segment list at COLS columns (word-aware, by code point), keeping styles. */
function wrap(segs) {
  const chars = [...segs.map((s) => s.text).join('')];
  const ranges = [];
  let start = 0;
  while (chars.length - start > COLS) {
    let brk = -1;
    for (let i = start + COLS; i > start + COLS / 2; i--) {
      if (chars[i] === ' ') {
        brk = i;
        break;
      }
    }
    if (brk === -1) {
      ranges.push([start, start + COLS]);
      start += COLS;
    } else {
      ranges.push([start, brk]);
      start = brk + 1;
    }
  }
  ranges.push([start, chars.length]);
  const rows = ranges.map(() => []);
  let pos = 0;
  for (const seg of segs) {
    const sc = [...seg.text];
    ranges.forEach(([a, b], r) => {
      const from = Math.max(a, pos);
      const to = Math.min(b, pos + sc.length);
      if (to > from) rows[r].push({ ...seg, text: sc.slice(from - pos, to - pos).join('') });
    });
    pos += sc.length;
  }
  return rows;
}

function segAttrs(seg) {
  let fill = COLOR.text;
  if (seg.fg) fill = COLOR[seg.fg] ?? COLOR.text;
  else if (seg.dim) fill = COLOR.dim;
  const attrs = [`fill="${fill}"`];
  if (seg.bold) attrs.push('font-weight="bold"');
  if (seg.dim && seg.fg) attrs.push('opacity="0.75"');
  return attrs.join(' ');
}

/** Opacity 0 until second `t` of every LOOP_S-second cycle, then 1. Every element loops on its own, so no driver is needed. */
function appearAnim(t) {
  if (t <= 0) return '';
  const k = Math.min(0.999, t / LOOP_S).toFixed(4);
  return `<animate attributeName="opacity" calcMode="discrete" values="0;1;1" keyTimes="0;${k};1" dur="${LOOP_S}s" repeatCount="indefinite"/>`;
}

/** Rendered rows: segments plus the second each appears. A `typed` row reveals the claim character by character. */
const rows = [];
let clock = 0;
function addRow(segs, t, extra = {}) {
  for (const line of wrap(segs)) rows.push({ segs: line, t, ...extra });
}
function blank() {
  rows.push({ segs: [], t: 0 });
}

// Scene 1: the claim
clock = 0.4;
addRow([{ text: '$ ', fg: 'prompt', bold: true }, { text: 'claude', bold: true }], clock);
clock = 1.0;
addRow([{ text: '\u{1F916}  ' }, { text: CLAIM }], clock, { typed: true, typedEnd: clock + 1.5 });
clock += 1.5;
blank();

// Scene 2: the hook blocks
clock += 0.8;
addRow([{ text: '⛔ Stop hook: ', fg: 'red', bold: true }, { text: 'isitdone', bold: true }], clock);
clock += 0.5;
const reasonLines = reason.split('\n');
const tailStart = reasonLines.findIndex((l) => l.startsWith('--- '));
const trailerStart = reasonLines.lastIndexOf('') + 1;
const isTail = (i) => tailStart >= 0 && i >= tailStart && i < trailerStart;
const shown = reasonLines.length > REASON_CAP + 1 ? [...reasonLines.slice(0, REASON_CAP).map((l, i) => [l, i]), ['…', -1], ...reasonLines.slice(trailerStart).map((l, i) => [l, trailerStart + i])] : reasonLines.map((l, i) => [l, i]);
for (const [line, i] of shown) {
  let segs;
  if (i === -1) segs = [{ text: line, dim: true }];
  else if (isTail(i)) segs = highlight(line, /\bNOT DONE\b|\bFAIL\b/g, { fg: 'red' }, { dim: true });
  else segs = highlight(line, /\bNOT DONE\b|\bFAIL\b/g, { fg: 'red', bold: true });
  addRow(segs, clock);
  clock += line === '' ? 0.1 : 0.22;
}
blank();

// Scene 3: the fix
clock += 1.2;
addRow([{ text: '\u{1F916}  ' }, { text: FIX_NARRATION }], clock);
clock += 1.3;
blank();
addRow([{ text: '$ ', fg: 'prompt', bold: true }, { text: 'npx isitdone', bold: true }], clock);
clock += 0.7;

// Scene 4: the receipt (captured with colours)
const cliLines = cliAnsi.split('\n');
cliLines.forEach((line, i) => {
  addRow(parseAnsiLine(line), clock);
  // a pause after the header line, as if the check were running
  clock += i === 0 ? 1.1 : line === '' ? 0.1 : 0.35;
});
if (clock > LOOP_S - 4) console.warn(`warning: content ends at ${clock.toFixed(1)}s; loop is ${LOOP_S}s`);

const height = TITLE_H + PAD + rows.length * LINE_H + PAD;
const parts = [];
parts.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xml:space="preserve" style="white-space:pre" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13px">`,
);
parts.push('<title>isitdone demo</title>');
parts.push('<desc>An agent claims its work is done; the isitdone Stop hook runs the real tests, they fail, the stop is blocked; the agent fixes the bug and npx isitdone returns DONE with a receipt.</desc>');
parts.push(`<rect width="${WIDTH}" height="${height}" rx="10" fill="#111827"/>`);
parts.push(`<path d="M0 ${TITLE_H} H${WIDTH} V10 a10 10 0 0 0 -10 -10 H10 a10 10 0 0 0 -10 10 Z" fill="#1f2937"/>`);
parts.push('<circle cx="20" cy="18" r="6" fill="#f87171"/><circle cx="40" cy="18" r="6" fill="#fbbf24"/><circle cx="60" cy="18" r="6" fill="#4ade80"/>');
parts.push(`<text x="${WIDTH / 2}" y="23" text-anchor="middle" fill="#9ca3af" font-size="12px">isitdone</text>`);

rows.forEach((row, i) => {
  if (row.segs.length === 0) return;
  const y = TITLE_H + PAD + (i + 1) * LINE_H - 5;
  if (row.typed) {
    // the prefix appears at once, then the claim is typed character by character
    const [prefix, ...restSegs] = row.segs;
    const chars = [...restSegs.map((s) => s.text).join('')];
    const step = (row.typedEnd - row.t) / Math.max(1, chars.length);
    const spans = chars.map((ch, j) => `<tspan opacity="0">${esc(ch)}${appearAnim(row.t + step * (j + 1))}</tspan>`).join('');
    parts.push(`<text x="${PAD}" y="${y}" opacity="0" ${segAttrs({})}>${appearAnim(row.t)}<tspan>${esc(prefix.text)}</tspan>${spans}</text>`);
    return;
  }
  const spans = row.segs.map((s) => `<tspan ${segAttrs(s)}>${esc(s.text)}</tspan>`).join('');
  parts.push(`<text x="${PAD}" y="${y}" opacity="0">${appearAnim(row.t)}${spans}</text>`);
});
parts.push('</svg>');
const svg = parts.join('\n') + '\n';

mkdirSync(docsDir, { recursive: true });
writeFileSync(svgPath, svg);

const txt = [
  '# isitdone demo: text captured from a real run (scripts/demo.mjs).',
  `# The temp repository path was replaced by ${PLACEHOLDER}; nothing else was edited.`,
  '',
  '## step A: `isitdone hook --host claude` -> {"decision":"block","reason":...}',
  '',
  reason,
  '',
  '## step B: `isitdone --no-cache` (exit 0; ANSI colours stripped here)',
  '',
  stripAnsi(cliAnsi),
  '',
].join('\n');
writeFileSync(txtPath, txt);

console.log(`wrote ${svgPath} (${statSync(svgPath).size} bytes, ${rows.length} rows, ${height}px tall, loop ${LOOP_S}s, content ends at ${clock.toFixed(1)}s)`);
console.log(`wrote ${txtPath}`);

// ---------------------------------------------------------------------------------------------------------------------

function cleanup(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch {
      // Windows can hold handles briefly after a child exits; wait a little and try again
      const until = Date.now() + 300;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  console.warn(`warning: could not remove ${dir}`);
}
