import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { detectChecks } from './detect.js';
import { doctor } from './doctor.js';
import { findRoot, gitInfo } from './git.js';
import { readStdin, runHook } from './hook.js';
import { ensureGitignore, init, PACKAGE_NAME } from './init.js';
import { getHost, HOST_NAMES, type HostName } from './hosts.js';
import { formatDuration, styleFor } from './output.js';
import { configHash, evaluateReceipt } from './receipt.js';
import { formatMarkdown, formatReport, toJson } from './report.js';
import { verify, timeoutFor } from './verify.js';
import { VERSION } from './version.js';

/** Human-facing command. `isitdone` on npm is an alias of PACKAGE_NAME with the same bin. */
const NPX = 'npx isitdone';

const HELP = `isitdone ${VERSION} - don't let your coding agent say "done" until the checks actually pass.

Usage
  ${NPX}                      run the repo's test/typecheck/lint checks, write a receipt
  ${NPX} init                 install the Stop hook into Claude Code (and other detected agents)
  ${NPX} doctor               prove the hook fires and blocks
  ${NPX} receipt              show whether the current tree has a PASS receipt
  ${NPX} detect               show which checks would run
  ${NPX} hook --host <name>   (used by the agent) read the Stop payload on stdin, block if needed
  ${NPX} uninstall            remove the hook(s)

Options for run
  --profile <lite|full>   lite = typecheck+lint only, full = everything (default: full)
  --all                   keep running full checks even if a lite check failed
  --no-cache              re-run even if a PASS receipt exists for this exact tree
  --json                  machine-readable output (done: true|false)
  --claim "<text>"        record the completion claim being verified

Options for init
  --agent <name>          claude | codex | cursor | gemini | all | auto (default: auto)
  --user                  install into the user-level settings instead of the project
  --timeout <seconds>     hook timeout (default: sized to the detected checks, at least 600)
  --command "<cmd>"       hook command to register (default: npx -y ${PACKAGE_NAME} hook --host <name>)
  --remove                uninstall the hook(s)
  --no-doctor             skip the post-install doctor run
  --json                  machine-readable output

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
  flags: Record<string, string | boolean>;
  rest: string[];
}

const VALUE_FLAGS = new Set(['profile', 'claim', 'host', 'agent', 'timeout', 'command', 'cwd']);
const BOOL_FLAGS = new Set(['all', 'cache', 'json', 'md', 'user', 'remove', 'doctor', 'probe', 'version', 'help']);

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) {
        flags[key] = a.slice(eq + 1);
      } else if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !(argv[i + 1] as string).startsWith('--')) {
        flags[key] = argv[++i] as string;
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
  const res = await verify({
    root,
    config,
    profile,
    claim: typeof args.flags.claim === 'string' ? args.flags.claim : null,
    host: typeof args.flags.host === 'string' ? args.flags.host : null,
    all: args.flags.all === true,
    useCache: args.flags.cache !== false,
    onCheckStart: live ? (c) => process.stdout.write(s.dim(`  running ${c.cmd} ...`)) : undefined,
    onCheckDone: live ? () => process.stdout.write(`\r${' '.repeat(70)}\r`) : undefined,
  });
  const state = res.receipt ? (res.receipt.status === 'PASS' ? 'PASS' : 'FAIL') : res.cached ? 'PASS' : 'NONE';
  if (json) out(JSON.stringify(toJson(res, state), null, 2));
  else out(formatReport(res, s));
  return res.ok ? 0 : 1;
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
    const color = ev.state === 'PASS' ? s.green : ev.state === 'FAIL' ? s.red : s.yellow;
    const label = ev.state === 'PASS' && ev.receipt?.profile === 'lite' ? 'PASS (lite)' : ev.state;
    out(`${s.bold('isitdone receipt')}  ${color(s.bold(label))}  ${s.dim(ev.reason)}`);
    if (ev.receipt) {
      const r = ev.receipt;
      out(`  ${s.dim(`created ${r.createdAt} on ${r.branch ?? 'detached'}@${(r.head ?? '').slice(0, 7)} tree ${r.tree.slice(0, 7)}, profile ${r.profile}${r.host ? `, host ${r.host}` : ''}`)}`);
      for (const c of r.checks) out(`  ${c.cmd}  ${c.status === 'PASS' ? s.green('PASS') : s.red(c.status)}  ${s.dim(formatDuration(c.durationMs))}  ${s.dim(c.summary ?? '')}`.trimEnd());
      if (r.claim) out(`  ${s.dim('claim: ' + JSON.stringify(r.claim))}`);
      if (ev.state === 'PASS' && r.profile === 'lite') out(`  ${s.yellow('tests were not run; run `' + NPX + '` for a full receipt')}`);
    }
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
  const s = styleFor(process.stdout);
  out(`${s.bold('isitdone detect')}  ${s.dim(root)}${source ? s.dim(`  (config: ${source})`) : ''}`);
  if (d.checks.length === 0) out(`  ${s.yellow('no checks detected')}`);
  for (const c of d.checks) out(`  ${s.cyan(c.id.padEnd(10))} ${c.cmd.padEnd(32)} ${s.dim(`${c.kind}  ${timeoutFor(c, config) / 1000}s  from ${c.source}`)}`);
  for (const n of d.notes) out(`  ${s.dim('note: ' + n)}`);
  return 0;
}

async function cmdHook(args: Args): Promise<number> {
  const host = typeof args.flags.host === 'string' ? args.flags.host : '';
  if (!HOST_NAMES.includes(host as HostName)) {
    err(`isitdone hook: --host must be one of ${HOST_NAMES.join(', ')}`);
    return 3;
  }
  const stdin = await readStdin();
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
    const report = !remove && args.flags.doctor !== false ? await doctor({ root, probeHooks: args.flags.probe !== false }) : null;
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
  for (const r of results) {
    const verb = r.action === 'added' ? s.green('added') : r.action === 'updated' ? s.cyan('updated') : r.action === 'removed' ? s.yellow('removed') : s.dim(r.action);
    out(`  ${r.displayName.padEnd(12)}${verb.padEnd(r.action.length + 10)} ${s.dim(`${r.path}${r.action === 'added' || r.action === 'updated' ? ` (timeout ${r.timeout}s)` : ''}`)}`);
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
  const report = await doctor({ root, probeHooks: args.flags.probe !== false });
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
  out(report.ok ? `  ${s.green(s.bold('OK'))}   the agent cannot claim done with failing checks in this repo` : `  ${s.yellow(s.bold('ATTENTION'))}   fix the items marked !! above`);
  return report.ok ? 0 : 1;
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
