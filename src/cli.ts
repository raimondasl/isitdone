import { existsSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { toSarif } from './sarif.js';
import { detectChecks } from './detect.js';
import { doctor } from './doctor.js';
import { dirtyPathSet, findRoot, gitInfo, gitTopLevel } from './git.js';
import { activePause, clearPause, DEFAULT_PAUSE_MS, describePause, formatPauseTime, isAgentShell, MAX_PAUSE_MS, parseDuration, parseUntil, pauseFiles, writePause, type ActivePause } from './pause.js';
import { readStdin, runEditHook, runHook } from './hook.js';
import { liveSessionsNote, LOCK_WAIT_MS } from './sessions.js';
import { ensureGitignore, init, installedHooks, PACKAGE_NAME } from './init.js';
import { getHost, HOST_NAMES, type HostName } from './hosts.js';
import { parseSince, scanHistory, type HistoryReport } from './history.js';
import { runMcpServer } from './mcp.js';
import { styleFor, share } from './output.js';
import { configHash, evaluateReceipt } from './receipt.js';
import { formatDetection, formatMarkdown, formatReceiptState, formatReport, formatReportMarkdown, integrityBlocks, receiptStateOf, toJson } from './report.js';
import { findNpxEntries, isNewer, npmCacheDir, runUpdate } from './update.js';
import { tryReadJsonFile } from './fsutil.js';
import { verify, timeoutFor } from './verify.js';
import { VERSION } from './version.js';

/** Human-facing command. `isitdone` on npm is an alias of PACKAGE_NAME with the same bin. */
const NPX = 'npx isitdone';

const HELP = `isitdone ${VERSION} - don't let your coding agent say "done" until the checks actually pass.

Usage
  ${NPX}                      run the repo's test/typecheck/lint checks, write a receipt
  ${NPX} init                 install the Stop hook into Claude Code (and other detected agents)
  ${NPX} doctor               prove the hook fires and blocks, and that the checks start green
  ${NPX} receipt              show whether the current tree has a PASS receipt
  ${NPX} detect               show which checks would run
  ${NPX} hook --host <name>   (used by the agent) read the Stop payload on stdin, block if needed;
                          <name> is one of ${HOST_NAMES.join(', ')}
  ${NPX} uninstall            remove the hook(s)
  ${NPX} pause                (you, not the agent) let every stop through unchecked for a while, then switch back on
  ${NPX} resume               end this repository's pause early (--global: the user-wide one)
  ${NPX} history              how many of your agent's past "done" claims had a test run behind them
  ${NPX} update               refresh the npx-cached hook to the latest release (--check only reports)
  ${NPX} mcp                  (used by the IDE) Model Context Protocol server on stdio, for agents without a stop hook:
                          tools isitdone_verify, isitdone_receipt, isitdone_detect

Options for run
  --profile <lite|full>   lite = typecheck+lint only, full = everything (default: full)
  --all                   keep running full checks even if a lite check failed
  --no-cache              re-run even if a PASS receipt exists for this exact tree
  --json                  machine-readable output (done: true|false)
  --claim "<text>"        record the completion claim being verified
  --base <ref>            diff against <ref> for the test-integrity scan (default: HEAD)
  --strict                block when the change weakened tests (high/critical findings)
  --ci                    strict, and new "isitdone: allow" suppressions count as findings
  --sarif <file>          also write the integrity findings as SARIF 2.1.0 (GitHub code scanning)
  --report <file>         also write a markdown report (job summaries, PR comments)
  --json-file <file>      also write the JSON result to a file

Options for history  (reads Claude Code, Codex, Gemini CLI, Qwen Code and Cursor transcripts locally; nothing leaves the machine)
  --since <30d|2w|2026-01-01>   only sessions after this point
  --until <2026-01-31>    only turns up to this point (a bare date includes the whole day, UTC)
  --exclude <substring>   skip projects whose path contains this (repeatable; also .isitdone.json history.exclude)
  --verbose               list every claim with its verdict
  --min <pct>             exit 1 if fewer than <pct>% of claims were verified
  --json                  machine-readable
  --include-subagents     also scan subagent transcripts

Options for init
  --agent <name>          ${HOST_NAMES.join(' | ')} | all | auto
                          (default: auto = every agent with a settings dir in the repo; comma-separate to name several;
                          opencode gets a plugin file instead of a hook entry, junie is user-level only)
  --user                  install into the user-level settings instead of the project
  --timeout <seconds>     hook timeout (default: sized to the detected checks, at least 600)
  --command "<cmd>"       hook command to register (default: npx -y ${PACKAGE_NAME} hook --host <name>); it must
                          forward extra arguments, since the edit hook is the same command plus --event edit
  --remove                uninstall the hook(s)
  --no-edit-hook          only the Stop hook; skip the warn-only hook that runs after each test-file edit
  --no-doctor             skip the post-install doctor run
  --no-baseline           skip running the detected checks once on the current tree (doctor accepts it too)
  --json                  machine-readable output

Options for pause  (the Stop hook only, in this repository and its worktrees; running sessions pick it up at their next stop)
  --for <30m|2h|3d|1w>    how long (default 1h, at most 30 days; m is minutes here)
  --until <time>          2026-11-02 (end of that day), 2026-11-02T11:00 (local time) or 2026-11-02T11:00Z
  --global                every repository of this user (this home directory), not just this one

Options for receipt
  --md                    markdown table for a PR body
  --json                  machine-readable

Common
  --cwd <dir>             run as if started in <dir>
  --version, --help

Exit codes: 0 done/ok, 1 not done, 3 usage or internal error.
Config: .isitdone.json or "isitdone" in package.json. Docs: https://github.com/raimondasl/isitdone
`;

interface Args {
  command: string;
  flags: Record<string, string | boolean | string[]>;
  rest: string[];
}

const VALUE_FLAGS = new Set(['profile', 'claim', 'host', 'agent', 'timeout', 'command', 'cwd', 'base', 'since', 'until', 'exclude', 'min', 'sarif', 'event', 'file', 'report', 'json-file', 'for']);
const BOOL_FLAGS = new Set(['all', 'cache', 'json', 'md', 'user', 'remove', 'doctor', 'probe', 'version', 'help', 'strict', 'ci', 'verbose', 'include-subagents', 'check', 'warm', 'latest', 'edit-hook', 'baseline', 'global']);
/** Flags that may repeat; collected as arrays. */
const MULTI_FLAGS = new Set(['exclude']);

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean | string[]> = {};
  const rest: string[] = [];
  const setValue = (key: string, value: string) => {
    if (MULTI_FLAGS.has(key)) {
      const prev = flags[key];
      flags[key] = Array.isArray(prev) ? [...prev, value] : [value];
    } else {
      flags[key] = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) {
        setValue(key, a.slice(eq + 1));
      } else if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !(argv[i + 1] as string).startsWith('--')) {
        setValue(key, argv[++i] as string);
      } else if (key.startsWith('no-')) {
        flags[key.slice(3)] = false;
      } else {
        flags[key] = true;
      }
    } else if (a === '-v') {
      flags.version = true;
    } else if (a === '-h') {
      flags.help = true;
    } else {
      rest.push(a);
    }
  }
  const command = rest.shift() ?? 'run';
  return { command, flags, rest };
}

function unknownFlags(args: Args): string[] {
  return Object.keys(args.flags).filter((k) => !VALUE_FLAGS.has(k) && !BOOL_FLAGS.has(k));
}

function out(s: string): void {
  process.stdout.write(s + '\n');
}
function err(s: string): void {
  process.stderr.write(s + '\n');
}

function repoRoot(flags: Args['flags']): string {
  const cwd = typeof flags.cwd === 'string' ? resolve(flags.cwd) : process.cwd();
  return findRoot(cwd);
}

async function cmdRun(args: Args): Promise<number> {
  if (process.env.ISITDONE === '1') {
    err('isitdone: refusing to run nested inside an isitdone check (remove isitdone from that check command, or disable the check in .isitdone.json)');
    return 3;
  }
  const root = repoRoot(args.flags);
  const { config } = loadConfig(root);
  const profileFlag = args.flags.profile;
  const profile = profileFlag === 'lite' ? 'lite' : 'full';
  if (profileFlag !== undefined && profileFlag !== 'lite' && profileFlag !== 'full') {
    err(`--profile must be lite or full (got ${String(profileFlag)})`);
    return 3;
  }
  const json = args.flags.json === true;
  const s = styleFor(process.stdout);
  const live = !json && Boolean(process.stdout.isTTY);
  const ci = args.flags.ci === true;
  const strict = ci || args.flags.strict === true;
  const res = await verify({
    root,
    config: strict ? { ...config, integrity: 'strict' } : config,
    profile,
    claim: typeof args.flags.claim === 'string' ? args.flags.claim : null,
    host: typeof args.flags.host === 'string' ? args.flags.host : null,
    all: args.flags.all === true,
    useCache: args.flags.cache !== false,
    base: typeof args.flags.base === 'string' ? args.flags.base : undefined,
    ci,
    // The agent a Stop hook just sent here must not run the suite on top of the other session's hook run.
    lockWaitMs: config.otherSessions === 'ignore' ? 0 : LOCK_WAIT_MS,
    onLockWait: () => err('isitdone: another check run is in progress in this directory; waiting for it (up to 3 minutes) ...'),
    onCheckStart: live ? (c) => process.stdout.write(s.dim(`  running ${c.cmd} ...`)) : undefined,
    onCheckDone: live ? () => process.stdout.write(`\r${' '.repeat(70)}\r`) : undefined,
  });
  const state = receiptStateOf(res);
  if (typeof args.flags.sarif === 'string' && res.integrity) {
    writeFileSync(resolve(args.flags.sarif), JSON.stringify(toSarif(res.integrity, { base: typeof args.flags.base === 'string' ? args.flags.base : 'HEAD' }), null, 2) + '\n');
  }
  if (typeof args.flags.report === 'string') {
    writeFileSync(resolve(args.flags.report), formatReportMarkdown(res, state) + '\n');
  }
  if (typeof args.flags['json-file'] === 'string') {
    writeFileSync(resolve(args.flags['json-file']), JSON.stringify(toJson(res, state), null, 2) + '\n');
  }
  if (json) out(JSON.stringify(toJson(res, state), null, 2));
  else {
    out(formatReport(res, s));
    // The CLI cannot know which session is asking; on a failure it says who edited what, so nobody fixes the other's files.
    const sessions = !res.ok && res.git.isRepo && config.otherSessions !== 'ignore' ? liveSessionsNote([res.git.root, root], () => dirtyPathSet(res.git.root)) : null;
    if (sessions) out(s.yellow(sessions));
    const pause = activePause(pauseFiles(res.git.isRepo ? res.git.root : root));
    if (pause) out(s.yellow(`note: the Stop hook is paused ${describePause(pause)}: agents' stops go through unchecked until then (\`${NPX} resume\` ends it)`));
  }
  return res.ok && !integrityBlocks(res) ? 0 : 1;
}

const pct = share;

async function cmdHistory(args: Args): Promise<number> {
  const root = repoRoot(args.flags);
  let configExclude: string[] = [];
  try {
    configExclude = loadConfig(root).config.history?.exclude ?? [];
  } catch {
    // config problems are reported by run/doctor
  }
  const flagExclude = Array.isArray(args.flags.exclude) ? args.flags.exclude : typeof args.flags.exclude === 'string' ? [args.flags.exclude] : [];
  const sinceRaw = typeof args.flags.since === 'string' ? args.flags.since : null;
  const since = sinceRaw ? parseSince(sinceRaw) : null;
  if (sinceRaw && !since) {
    err(`--since must look like 30d, 2w, 12h or an ISO date (got ${sinceRaw})`);
    return 3;
  }
  const untilRaw = typeof args.flags.until === 'string' ? args.flags.until : null;
  // A bare date means "through the end of that day"; anything else is the moment given.
  const until = untilRaw ? (/^\d{4}-\d{2}-\d{2}$/.test(untilRaw.trim()) ? new Date(Date.parse(`${untilRaw.trim()}T23:59:59.999Z`)) : parseSince(untilRaw)) : null;
  if (untilRaw && (!until || Number.isNaN(until.getTime()))) {
    err(`--until must be an ISO date or time, or look like 30d, 2w, 12h (got ${untilRaw})`);
    return 3;
  }
  const min = typeof args.flags.min === 'string' ? Number(args.flags.min) : null;
  if (min !== null && !(min >= 0 && min <= 100)) {
    err('--min must be a percentage between 0 and 100');
    return 3;
  }
  const json = args.flags.json === true;
  const s = styleFor(process.stdout);
  const live = !json && Boolean(process.stdout.isTTY);
  const report: HistoryReport = await scanHistory({
    since,
    until,
    exclude: [...configExclude, ...flagExclude],
    includeSubagents: args.flags['include-subagents'] === true,
    onProgress: live ? (done, total) => process.stdout.write(`\r  scanning ${done}/${total} sessions ...`) : undefined,
  });
  if (live) process.stdout.write(`\r${' '.repeat(50)}\r`);
  const total = report.claims.length;
  const verified = report.counts.VERIFIED;
  if (json) {
    out(JSON.stringify({ ...report, claims: args.flags.verbose === true ? report.claims : undefined }, null, 2));
  } else {
    out(`${s.bold('isitdone history')}  ${s.dim(report.projectsDir)}${report.since ? s.dim(`  since ${report.since.slice(0, 10)}`) : ''}${report.until ? s.dim(`  until ${report.until.slice(0, 10)}`) : ''}`);
    out(`  scanned ${report.scannedFiles} session${report.scannedFiles === 1 ? '' : 's'} in ${report.byProject.length || 'no'} project${report.byProject.length === 1 ? '' : 's'}; ${report.editTurns} turns edited files; ${total} of those ended with a completion claim${report.excludedDirs.length ? s.dim(`; ${report.excludedDirs.length} project dir${report.excludedDirs.length === 1 ? '' : 's'} excluded`) : ''}`);
    for (const [agent, a] of Object.entries(report.byAgent)) {
      if (a.sessions === 0) continue;
      const lossy = a.lossy ? s.yellow(`  exit codes unavailable in ${a.lossy} session${a.lossy === 1 ? '' : 's'} (test runs assumed to pass)`) : '';
      out(`  ${s.dim(pad(agent, 12))} ${pad(`${a.sessions} session${a.sessions === 1 ? '' : 's'}`, 13)} ${pad(`${a.claims} claim${a.claims === 1 ? '' : 's'}`, 11)} ${pad(pct(a.verified, a.claims), 5)} verified${lossy}`);
    }
    if (total === 0) {
      out(`  ${s.yellow('no completion claims found')}  ${s.dim('(no Claude Code, Codex, Gemini CLI, Qwen Code or Cursor transcripts found, or none with file edits)')}`);
      return 0;
    }
    out('');
    out(`  ${s.green('VERIFIED')}   ${pad(pct(verified, total), 5)} ${s.dim(pad(`(${verified})`, 7))} a test command passed after the last edit`);
    out(`  ${s.yellow('STALE')}      ${pad(pct(report.counts.STALE, total), 5)} ${s.dim(pad(`(${report.counts.STALE})`, 7))} tests passed, then more edits, no re-run`);
    out(`  ${s.red('FAILED')}     ${pad(pct(report.counts.FAILED, total), 5)} ${s.dim(pad(`(${report.counts.FAILED})`, 7))} the last test run failed, "done" claimed anyway`);
    out(`  ${s.red('NEVER RAN')}  ${pad(pct(report.counts.NEVER_RAN, total), 5)} ${s.dim(pad(`(${report.counts.NEVER_RAN})`, 7))} no test command in the turn at all`);
    out('');
    out(`  ${s.bold(`${pct(total - verified, total)} of "done" claims (${total - verified} of ${total}) had no passing test run behind them.`)}`);
    const mixed = report.claims.filter((c) => c.verdict === 'VERIFIED' && c.testFails > 0).length;
    if (mixed > 0) out(`  ${s.yellow(`${mixed} of the verified claims had a failed test run earlier in the same turn; only the last command passed, and it may have been a narrower one (--verbose marks them).`)}`);
    const g = report.gate;
    if (g) {
      out('');
      out(`  ${s.bold('gate')}  the isitdone Stop hook decided ${g.checked} stop${g.checked === 1 ? '' : 's'} in ${g.projects} project${g.projects === 1 ? '' : 's'} ${s.dim('(.isitdone/decisions.jsonl)')}`);
      out(`        ${g.passed} passed; ${g.blockedTurns} turn${g.blockedTurns === 1 ? '' : 's'} blocked: ${g.fixed} fixed and then passed, ${g.gaveUp} gave up after the cap, ${g.released} released${g.pausedTurns ? `, ${g.pausedTurns} let go by a pause` : ''}${g.open ? `, ${g.open} still open` : ''}`);
      if (g.claims) out(`        ${g.claims} stop${g.claims === 1 ? '' : 's'} claimed done; ${g.claimsBlocked} of them ${g.claimsBlocked === 1 ? 'was' : 'were'} refused (${pct(g.claimsBlocked, g.claims)})`);
      if (g.pausedStops) out(`        ${g.pausedStops} stop${g.pausedStops === 1 ? ' was' : 's were'} let through unchecked while the gate was paused (\`isitdone pause\`)`);
      out(`        ${s.dim('transcripts only show the tests the agent ran itself; the hook\'s own runs in these projects are counted here, not above')}`);
    }
    const worst = [...report.byProject].filter((p) => p.claims >= 5).sort((a, b) => b.unbackedPct - a.unbackedPct)[0];
    if (worst) out(`  worst project  ${worst.project}  ${pct(worst.claims - worst.verified, worst.claims)} unbacked (${worst.claims - worst.verified} of ${worst.claims} claims)`);
    if (args.flags.verbose === true) {
      out('');
      for (const c of report.claims) out(`  ${pad(c.verdict, 9)} ${s.dim(c.at.slice(0, 10))}  ${s.dim(c.project)}  ${JSON.stringify(c.claim)}${c.lossy ? s.yellow('  (no exit codes)') : ''}${c.verdict === 'VERIFIED' && c.testFails > 0 ? s.yellow(`  (after ${c.testFails} failed run${c.testFails === 1 ? '' : 's'})`) : ''}`);
    } else {
      out('');
      out(`  ${s.dim('per project:')}`);
      for (const p of report.byProject.slice(0, 10)) out(`  ${pad(pct(p.verified, p.claims), 5)} verified  ${pad(String(p.claims), 4)} claims  ${s.dim(p.project)}`);
      if (report.byProject.length > 10) out(`  ${s.dim(`... ${report.byProject.length - 10} more`)}`);
    }
    out('');
    out(`  ${s.dim('make the agent prove it:')}  ${NPX} init`);
  }
  if (min !== null && total > 0 && Math.round((100 * verified) / total) < min) return 1;
  return 0;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

async function cmdReceipt(args: Args): Promise<number> {
  const root = repoRoot(args.flags);
  const git = gitInfo(root);
  const ev = evaluateReceipt(root, git, configHash(root));
  const s = styleFor(process.stdout);
  const done = ev.state === 'PASS' && ev.receipt?.profile === 'full';
  if (args.flags.json === true) {
    out(JSON.stringify({ state: ev.state, reason: ev.reason, done, receipt: ev.receipt, tree: git.tree }, null, 2));
  } else if (args.flags.md === true) {
    if (!ev.receipt) out(`No isitdone receipt (${ev.reason}). Run \`${NPX}\`.`);
    else out(formatMarkdown(ev.receipt, ev.state));
  } else {
    out(formatReceiptState(ev, s, `run \`${NPX}\``));
  }
  return done ? 0 : 1;
}

function cmdDetect(args: Args): number {
  const root = repoRoot(args.flags);
  const { config, source } = loadConfig(root);
  const d = detectChecks(root, config);
  if (args.flags.json === true) {
    out(JSON.stringify({ root, configSource: source, stacks: d.stacks, checks: d.checks.map((c) => ({ ...c, timeoutSeconds: timeoutFor(c, config) / 1000 })), env: d.env, notes: d.notes }, null, 2));
    return 0;
  }
  out(formatDetection(root, d, config, source, styleFor(process.stdout)));
  return 0;
}

/** The MCP server owns stdin/stdout until the client closes stdin. */
async function cmdMcp(args: Args): Promise<number> {
  return runMcpServer({ cwd: typeof args.flags.cwd === 'string' ? resolve(args.flags.cwd) : undefined });
}

async function cmdHook(args: Args): Promise<number> {
  const host = typeof args.flags.host === 'string' ? args.flags.host : '';
  if (!HOST_NAMES.includes(host as HostName)) {
    err(`isitdone hook: --host must be one of ${HOST_NAMES.join(', ')}`);
    return 3;
  }
  const stdin = await readStdin();
  if (args.flags.event === 'edit') {
    // Warn-only: never blocks, never fails the tool call.
    const o = runEditHook({ host, stdin, cwd: typeof args.flags.cwd === 'string' ? resolve(args.flags.cwd) : process.cwd() });
    if (process.env.ISITDONE_DEBUG) err(`isitdone edit hook: ${o.why}`);
    if (o.stdout !== '') process.stdout.write(o.stdout + '\n');
    return 0;
  }
  const profile = args.flags.profile;
  const outcome = await runHook({
    host,
    stdin,
    cwd: typeof args.flags.cwd === 'string' ? resolve(args.flags.cwd) : process.cwd(),
    doctor: process.env.ISITDONE_DOCTOR === '1',
    profile: profile === 'lite' || profile === 'full' || profile === 'claim-gated' ? profile : undefined,
  });
  if (process.env.ISITDONE_DEBUG) err(`isitdone hook: ${outcome.decision} - ${outcome.why}`);
  if (outcome.stdout !== '') process.stdout.write(outcome.stdout + '\n');
  if (outcome.stderr !== '') process.stderr.write(outcome.stderr + '\n');
  return outcome.exitCode;
}

async function cmdInit(args: Args): Promise<number> {
  const root = repoRoot(args.flags);
  const s = styleFor(process.stdout);
  const json = args.flags.json === true;
  const agentFlag = typeof args.flags.agent === 'string' ? args.flags.agent : 'auto';
  let hosts: HostName[] | 'auto' | 'all';
  if (agentFlag === 'auto' || agentFlag === 'all') hosts = agentFlag;
  else {
    const names = agentFlag.split(',').map((x) => x.trim());
    for (const n of names) {
      if (!HOST_NAMES.includes(n as HostName)) {
        err(`--agent must be one of ${HOST_NAMES.join(', ')}, all, auto (got ${n})`);
        return 3;
      }
    }
    hosts = names as HostName[];
  }
  const timeout = typeof args.flags.timeout === 'string' ? Number(args.flags.timeout) : undefined;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) {
    err('--timeout must be a positive whole number of seconds');
    return 3;
  }
  const remove = args.flags.remove === true;
  const command = typeof args.flags.command === 'string' ? args.flags.command : undefined;
  let results;
  try {
    results = init({
      root,
      hosts,
      scope: args.flags.user === true ? 'user' : 'project',
      timeout,
      remove,
      command: command ? () => command : undefined,
      editHook: args.flags['edit-hook'] !== false,
    });
  } catch (e) {
    err(`isitdone init: ${(e as Error).message}`);
    return 3;
  }

  const { config } = loadConfig(root);
  const d = detectChecks(root, config);
  let gi: 'added' | 'present' | 'skipped' = 'skipped';
  if (!remove) gi = ensureGitignore(root);

  if (json) {
    const report = !remove && args.flags.doctor !== false ? await doctor({ root, probeHooks: args.flags.probe !== false, checkLatest: args.flags.latest !== false, baseline: args.flags.baseline !== false }) : null;
    out(JSON.stringify({ root, hooks: results, detected: d.checks, notes: d.notes, gitignore: gi, doctor: report }, null, 2));
    return report ? (report.ok ? 0 : 1) : 0;
  }

  out(`${s.bold('isitdone init')}  ${s.dim(root)}`);
  if (!remove) {
    if (d.checks.length === 0) out(`  ${s.yellow('detected   no checks')}  ${s.dim('(add package.json scripts or a .isitdone.json; the hook allows every stop until then)')}`);
    else out(`  detected   ${d.checks.map((c) => c.cmd).join(', ')}`);
    out(`  profile    ${config.profile ?? 'claim-gated'}  ${s.dim('(lite checks on every stop, full checks when the agent claims done)')}`);
    if (gi === 'added') out(`  gitignore  added .isitdone/`);
  }
  const nameWidth = Math.max(12, ...results.map((r) => r.displayName.length + 1));
  for (const r of results) {
    const verb = r.action === 'added' ? s.green('added') : r.action === 'updated' ? s.cyan('updated') : r.action === 'removed' ? s.yellow('removed') : r.action === 'skipped' ? s.yellow('skipped') : s.dim(r.action);
    // pad on the visible text, not the coloured string
    out(`  ${r.displayName.padEnd(nameWidth)}${verb}${' '.repeat(Math.max(1, 11 - r.action.length))}${s.dim(`${r.hostEvent.padEnd(18)} ${r.path}${r.action === 'added' || r.action === 'updated' ? ` (timeout ${r.timeout}s)` : ''}`)}`);
  }
  const notes = results.filter((r) => r.note && r.action !== 'removed' && r.action !== 'absent');
  for (const r of notes) out(`  ${s.dim('note:')} ${r.note}`);

  if (!remove && args.flags.doctor !== false) {
    out('');
    return await cmdDoctor(args);
  }
  return 0;
}

async function cmdDoctor(args: Args): Promise<number> {
  const root = repoRoot(args.flags);
  const s = styleFor(process.stdout);
  const live = args.flags.json !== true && Boolean(process.stdout.isTTY);
  const report = await doctor({
    root,
    probeHooks: args.flags.probe !== false,
    checkLatest: args.flags.latest !== false,
    baseline: args.flags.baseline !== false,
    onCheckStart: live ? (c) => process.stdout.write(s.dim(`  baseline: running ${c.cmd} ...`)) : undefined,
    onCheckDone: live ? () => process.stdout.write(`\r${' '.repeat(70)}\r`) : undefined,
  });
  if (args.flags.json === true) {
    out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  out(`${s.bold('isitdone doctor')}  ${s.dim(root)}`);
  for (const c of report.checks) {
    const mark = c.name.startsWith('note') ? s.dim('i') : c.ok ? s.green('ok') : s.red('!!');
    out(`  ${mark.padEnd(c.name.startsWith('note') ? 11 : 12)} ${s.bold(c.name.padEnd(14))} ${c.detail}`);
    if (c.hint && !c.ok) out(`  ${' '.repeat(2)} ${s.dim('-> ' + c.hint)}`);
  }
  out('');
  if (!report.ok) out(`  ${s.yellow(s.bold('ATTENTION'))}   fix the items marked !! above`);
  else if (report.paused) out(`  ${s.yellow(s.bold('PAUSED'))}   the hook works, but lets every stop through until ${formatPauseTime(Date.parse(report.paused.until))} (\`${NPX} resume${report.paused.scope === 'global' ? ' --global' : ''}\` ends it)`);
  else out(`  ${s.green(s.bold('OK'))}   the agent cannot claim done with failing checks in this repo`);
  return report.ok ? 0 : 1;
}

/** The first release whose hook reads pauses; a hook that runs an older copy ignores them. */
const PAUSE_SINCE = '0.9.0';

function pauseCwd(flags: Args['flags']): string | null {
  const cwd = typeof flags.cwd === 'string' ? resolve(flags.cwd) : process.cwd();
  return existsSync(cwd) ? cwd : null;
}

/** hooks.json files under Claude Code's plugin folder that pin a version of isitdone (the plugin's hooks do). Bounded walk. */
function pinnedPluginHooks(dir: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  let budget = 5000;
  const walk = (d: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget < 0) return;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 7 && e.name !== 'node_modules' && e.name !== '.git') walk(p, depth + 1);
      else if (e.isFile() && e.name === 'hooks.json') {
        const pinned = /@aivolution\/isitdone@(\d+\.\d+\.\d+)/.exec(readFileSync(p, 'utf8'))?.[1];
        if (pinned) found.push([p, pinned]);
      }
    }
  };
  walk(dir, 0);
  return found;
}

/** Copies of isitdone that a hook may run and that would not see a pause: older npx-cached, pinned or installed ones. */
function stalePauseReaders(cwd: string, top: string | null): string[] {
  const found: string[] = [];
  try {
    const cache = npmCacheDir();
    const old = new Set<string>();
    for (const dir of cache ? findNpxEntries(cache) : []) {
      const v = tryReadJsonFile<{ version?: string }>(join(dir, 'node_modules', '@aivolution', 'isitdone', 'package.json'))?.version;
      if (typeof v === 'string' && isNewer(PAUSE_SINCE, v)) old.add(v);
    }
    if (old.size) found.push(`npx has isitdone ${[...old].join(', ')} cached; a hook that runs \`npx -y ${PACKAGE_NAME} hook\` may keep using it and ignore the pause until \`${NPX} update\` refreshes the cache (a hook pinned to an older version has to be updated itself)`);
  } catch {
    // best effort
  }
  try {
    const root = findRoot(cwd, top);
    for (const h of installedHooks(root)) {
      const pinned = h.event === 'stop' ? /@aivolution\/isitdone@(\d+\.\d+\.\d+)/.exec(h.command)?.[1] : undefined;
      if (pinned && isNewer(PAUSE_SINCE, pinned)) found.push(`the ${h.host.displayName} hook in ${h.path} is pinned to isitdone ${pinned}, which ignores pauses; re-run \`${NPX} init\` there and restart its sessions`);
    }
    for (const [file, pinned] of pinnedPluginHooks(join(homedir(), '.claude', 'plugins'))) {
      if (isNewer(PAUSE_SINCE, pinned)) found.push(`the Claude Code plugin copy at ${file} pins isitdone ${pinned}, which ignores pauses; if that plugin is installed, update it (/plugin) and restart its sessions`);
    }
    const local = tryReadJsonFile<{ version?: string }>(join(root, 'node_modules', '@aivolution', 'isitdone', 'package.json'))?.version;
    if (typeof local === 'string' && isNewer(PAUSE_SINCE, local)) found.push(`this project has isitdone ${local} in node_modules, which ignores pauses; \`npm update ${PACKAGE_NAME}\``);
  } catch {
    // best effort
  }
  return found;
}

function cmdPause(args: Args): number {
  const s = styleFor(process.stdout);
  // The gate is there for the agent; switching it off is the user's call, made in the user's own shell.
  if (isAgentShell()) {
    err(`isitdone pause: this is the user's switch, and this shell looks like one an agent host started (a terminal opened from inside an agent's app counts too). If you are the agent: ask the user to run \`${NPX} pause\` in a terminal of their own, and do not try to get around this.`);
    return 3;
  }
  if (args.rest.length > 0) {
    err(`isitdone pause: unexpected argument${args.rest.length === 1 ? '' : 's'} ${args.rest.map((a) => JSON.stringify(a)).join(' ')} (a length goes after --for; quote a time that has a space: --until "2026-11-02 11:00")`);
    return 3;
  }
  if (args.flags.for === true || args.flags.until === true) {
    err(`isitdone pause: --${args.flags.for === true ? 'for' : 'until'} needs a value`);
    return 3;
  }
  const forRaw = typeof args.flags.for === 'string' ? args.flags.for : null;
  const untilRaw = typeof args.flags.until === 'string' ? args.flags.until : null;
  if (forRaw !== null && untilRaw !== null) {
    err('isitdone pause: give --for or --until, not both');
    return 3;
  }
  const now = Date.now();
  let untilMs = now + DEFAULT_PAUSE_MS;
  if (forRaw !== null) {
    const d = parseDuration(forRaw);
    if (d === null) {
      err(`isitdone pause: --for must look like 30m, 2h, 3d or 1w (got ${forRaw})`);
      return 3;
    }
    untilMs = now + d;
  } else if (untilRaw !== null) {
    const u = parseUntil(untilRaw);
    if (u === null) {
      err(`isitdone pause: --until must be a real date or time, e.g. 2026-11-02, 2026-11-02T11:00 (local) or 2026-11-02T11:00Z (got ${untilRaw})`);
      return 3;
    }
    if (u <= now) {
      err(`isitdone pause: ${untilRaw} is already past`);
      return 3;
    }
    untilMs = u;
  }
  if (untilMs - now > MAX_PAUSE_MS) {
    err(`isitdone pause: a pause lasts at most 30 days, and this one would end ${formatPauseTime(untilMs)}; \`${NPX} uninstall\` removes the hook for longer`);
    return 3;
  }
  const cwd = pauseCwd(args.flags);
  if (!cwd) {
    err(`isitdone pause: --cwd ${String(args.flags.cwd)} does not exist`);
    return 3;
  }
  const global = args.flags.global === true;
  const top = gitTopLevel(cwd);
  if (!global && !top) {
    err(`isitdone pause: ${cwd} is not inside a git repository; add --global to pause the hook in every repository`);
    return 3;
  }
  let p: ActivePause;
  try {
    p = writePause(global ? 'global' : 'repo', cwd, untilMs, VERSION, now, top ?? undefined);
  } catch (e) {
    err(`isitdone pause: ${(e as Error).message}`);
    return 3;
  }
  const stale = stalePauseReaders(cwd, top);
  if (args.flags.json === true) {
    out(JSON.stringify({ paused: true, scope: p.scope, until: p.until, file: p.file, repository: global ? null : top, notYetInForce: stale }, null, 2));
    return 0;
  }
  out(`${s.bold('isitdone paused')}  ${describePause(p, now)}${global ? '' : s.dim(`  ${top} and its worktrees`)}`);
  out('  Agents\' stops go through without running the checks, and a check run already going is stopped. Every stop that');
  out(`  claims to be done says so in the session, on hosts that can show a message. \`${NPX} resume${global ? ' --global' : ''}\` ends it early.`);
  if (stale.length) for (const w of stale) out(s.yellow(`  not in force yet: ${w}`));
  else out(`  Hooks running isitdone ${PAUSE_SINCE} or later pick it up at their next stop, in sessions already running too.`);
  out(s.dim(`  ${p.file}; \`${NPX}\` by hand, the MCP tools and CI still run the checks.`));
  return 0;
}

function cmdResume(args: Args): number {
  const s = styleFor(process.stdout);
  if (args.rest.length > 0) {
    err(`isitdone resume: unexpected argument${args.rest.length === 1 ? '' : 's'} ${args.rest.map((a) => JSON.stringify(a)).join(' ')} (--global ends the user-wide pause)`);
    return 3;
  }
  const cwd = pauseCwd(args.flags);
  if (!cwd) {
    err(`isitdone resume: --cwd ${String(args.flags.cwd)} does not exist`);
    return 3;
  }
  const global = args.flags.global === true;
  if (!global && !gitTopLevel(cwd)) {
    err(`isitdone resume: ${cwd} is not inside a git repository; \`${NPX} resume --global\` ends the user-wide pause`);
    return 3;
  }
  const files = pauseFiles(cwd);
  let ended: ActivePause | null;
  try {
    ended = global ? clearPause(files.global, 'global') : clearPause(files.repo, 'repo');
  } catch (e) {
    err(`isitdone resume: ${(e as Error).message}`);
    return 1;
  }
  const still = activePause(pauseFiles(cwd));
  if (args.flags.json === true) {
    out(JSON.stringify({ resumed: ended ? { scope: ended.scope, until: ended.until, file: ended.file } : null, stillPaused: still ? { scope: still.scope, until: still.until, file: still.file } : null }, null, 2));
    return 0;
  }
  if (ended) out(`${s.bold('isitdone resumed')}  ${global ? 'the user-wide pause is over' : 'in this repository'}${s.dim(`  (it was to last until ${formatPauseTime(ended.untilMs)})`)}`);
  else out(`isitdone resume: no ${global ? 'user-wide pause' : 'pause for this repository'} was in force`);
  if (still) out(s.yellow(`  still paused ${describePause(still)}; \`${NPX} resume${still.scope === 'global' ? ' --global' : ''}\` ends that one`));
  return 0;
}

function cmdUpdate(args: Args): number {
  const s = styleFor(process.stdout);
  const json = args.flags.json === true;
  const checkOnly = args.flags.check === true;
  const r = runUpdate({ checkOnly, warm: args.flags.warm !== false });
  if (json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  out(`${s.bold('isitdone update')}  ${s.dim(`running ${r.running}${r.latest ? `, latest ${r.latest}` : ', registry unreachable'}`)}`);
  if (checkOnly) {
    if (r.latest && isNewer(r.latest, r.running)) out(`  ${s.yellow('outdated')}   ${r.latest} is available; run \`${NPX} update\``);
    else if (r.latest) out(`  ${s.green('up to date')}`);
    return 0;
  }
  if (r.removed.length === 0) out(`  ${s.dim('no cached npx copies found')}${r.cacheDir ? s.dim(` under ${r.cacheDir}`) : ''}`);
  for (const d of r.removed) out(`  removed    ${s.dim(d)}`);
  for (const w of r.warmed) out(`  ${w.version ? s.green('warmed ') : s.red('failed ')}    ${w.pkg.padEnd(24)} ${w.version ?? ''}${w.error ? s.dim('  ' + w.error) : ''}`);
  out(`  ${s.dim('hooks that run `npx -y ' + PACKAGE_NAME + ' hook ...` now use the refreshed copy; `npm i -D ' + PACKAGE_NAME + '` projects should run `npm update ' + PACKAGE_NAME + '`.')}`);
  return r.warmed.some((w) => w.error) ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.version === true || args.command === 'version') {
    out(VERSION);
    return 0;
  }
  if (args.flags.help === true || args.command === 'help') {
    out(HELP);
    return 0;
  }
  const isHook = args.command === 'hook';
  if (!isHook) {
    const bad = unknownFlags(args);
    if (bad.length > 0) {
      err(`isitdone: unknown option${bad.length === 1 ? '' : 's'} ${bad.map((b) => '--' + b).join(', ')} (see --help)`);
      return 3;
    }
  }
  try {
    switch (args.command) {
      case 'run':
      case 'check':
      case 'verify':
        return await cmdRun(args);
      case 'receipt':
        return await cmdReceipt(args);
      case 'detect':
        return cmdDetect(args);
      case 'hook':
        return await cmdHook(args);
      case 'init':
      case 'install':
        return await cmdInit(args);
      case 'uninstall':
        args.flags.remove = true;
        return await cmdInit(args);
      case 'doctor':
        return await cmdDoctor(args);
      case 'history':
        return await cmdHistory(args);
      case 'update':
        return cmdUpdate(args);
      case 'pause':
        return cmdPause(args);
      case 'resume':
        return cmdResume(args);
      case 'mcp':
        return await cmdMcp(args);
      default:
        err(`isitdone: unknown command "${args.command}"\n`);
        err(HELP);
        return 3;
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (isHook) {
      // Never brick the agent: an internal error allows the stop, but says so where the user can see it.
      if (process.env.ISITDONE_DEBUG) err(`isitdone hook: internal error: ${msg}`);
      const host = typeof args.flags.host === 'string' && HOST_NAMES.includes(args.flags.host as HostName) ? getHost(args.flags.host) : null;
      const text = host?.allow(`isitdone: internal error (${msg}); the stop was allowed without verification. Run \`${NPX} doctor\`.`) ?? '';
      if (text !== '') process.stdout.write(text + '\n');
      return 0;
    }
    err(`isitdone: ${msg}`);
    return 3;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    err(`isitdone: ${(e as Error).message ?? String(e)}`);
    process.exitCode = 3;
  },
);
