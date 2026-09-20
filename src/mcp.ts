/**
 * `isitdone mcp`: a Model Context Protocol server on stdio, written against the wire format instead of the SDK so the
 * package stays dependency-free. One JSON-RPC 2.0 message per line; nothing but protocol messages on stdout.
 *
 * It exists for agents and IDEs that have no blocking stop hook (VS Code Copilot agent mode, Cline, Windsurf, Kiro,
 * Zed, JetBrains, Claude Desktop, Amp, Crush). A tool the model chooses to call is weaker than a hook the host
 * enforces: hosts with a hook should keep using `isitdone init`.
 *
 * The server is "dual-era" in the words of the 2026-07-28 specification:
 *  - legacy clients open with the `initialize` handshake (2024-11-05 ... 2025-11-25) and are served with the revision
 *    negotiated there; workspace roots come from a server-to-client `roots/list` request;
 *  - modern clients (2026-07-28) send no handshake: every request carries its protocol version and the client's
 *    capabilities in `_meta`, results carry `resultType`, `server/discover` advertises the versions, and roots are
 *    asked for with an `input_required` result that the client answers by retrying the call (MRTR).
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { detectChecks } from './detect.js';
import { findRoot, gitInfo } from './git.js';
import { formatDuration, plain } from './output.js';
import { configHash, evaluateReceipt } from './receipt.js';
import { formatDetection, formatReceiptState, formatReport, integrityBlocks, receiptStateOf, toJson } from './report.js';
import { timeoutFor, verify, type VerifyResult } from './verify.js';
import { VERSION } from './version.js';

/** Revisions that open with the `initialize` handshake, newest first. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Stateless revisions: version and client capabilities travel in every request's `_meta`. */
export const MODERN_VERSIONS = ['2026-07-28'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** The tool list and the discovery answer only change with the package version. */
const CACHE_TTL_MS = 3_600_000;
/** How long a legacy client gets to answer `roots/list` before the server's own cwd is used. */
const ROOTS_TIMEOUT_MS = 3000;
/** Progress heartbeat while a check runs, for clients whose tool timeout resets on progress. */
const HEARTBEAT_MS = 10_000;
/** Marks the retry of a call that was answered with `input_required` (nothing worse than the cwd fallback hangs on it). */
const ROOTS_STATE = 'isitdone-roots';

const SERVER_INFO = { name: 'isitdone', version: VERSION };

export const INSTRUCTIONS = [
  "isitdone checks a coding task against the repository's real test, typecheck and lint commands.",
  'Before you tell the user that work is complete, fixed, passing or ready for review, call isitdone_verify (pass cwd: the absolute path of the repository, and claim: the sentence you are about to say) and paste its result into your reply.',
  'If the result says NOT DONE, the work is not done: fix the code and call isitdone_verify again instead of reporting completion.',
  'Never skip, delete, loosen or otherwise weaken tests or their configuration to make it pass; if a check is wrong for this repository, say so to the user.',
  'isitdone_receipt tells whether the current tree already has a PASS receipt; isitdone_detect lists the checks that would run.',
].join(' ');

type Id = string | number;
type Json = Record<string, unknown>;

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** What a request is served with: the revision, and what the client said about itself. */
interface Ctx {
  version: string;
  modern: boolean;
  /** The client declared the roots capability. */
  roots: boolean;
  clientName: string | null;
}

interface ToolOutcome {
  text: string;
  structured?: Json;
  isError: boolean;
}

/** A result the dispatcher sends as-is (MRTR `input_required`), instead of a finished tool outcome. */
interface RawResult {
  raw: Json;
}

interface Flight {
  key: string;
  promise: Promise<VerifyResult | null>;
  abort: AbortController;
}

/** Bad tool arguments: reported as a tool execution error (isError) so the model can correct itself. */
class ToolInputError extends Error {}

class RpcFailure extends Error {
  constructor(readonly rpc: RpcError) {
    super(rpc.message);
  }
}

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Longest output line handed to a model. */
const MAX_LINE = 400;

function clip(line: string): string {
  return line.length <= MAX_LINE ? line : `${line.slice(0, MAX_LINE - 3)}...`;
}

const STRING = { type: 'string' };
const STRINGS = { type: 'array', items: STRING };
const NULLABLE_STRING = { type: ['string', 'null'] };

const CWD_PROPERTY = {
  type: 'string',
  description: "Absolute path of the repository, or of a directory inside it. Default: the client's first workspace root, else the directory the server was started in.",
};

const CHECK_RESULT = {
  type: 'object',
  properties: {
    id: STRING,
    cmd: STRING,
    status: { type: 'string', enum: ['PASS', 'FAIL', 'TIMEOUT', 'ERROR'] },
    exitCode: { type: ['integer', 'null'] },
    durationMs: { type: 'number' },
    summary: NULLABLE_STRING,
    tail: { ...STRINGS, description: 'Last lines of the combined output; empty for checks that passed.' },
  },
  required: ['id', 'cmd', 'status', 'tail'],
};

const VERIFY_OUTPUT = {
  type: 'object',
  properties: {
    done: { type: 'boolean', description: 'True only when every full check passed on exactly this working tree and no test-integrity finding blocks.' },
    ok: { type: 'boolean', description: 'Every check that ran passed. With profile lite this can be true while done is false.' },
    noChecks: { type: 'boolean', description: 'No checks were detected, so nothing was verified.' },
    state: { type: 'string', enum: ['PASS', 'FAIL', 'NONE'], description: 'The receipt this run wrote or reused.' },
    profile: { type: 'string', enum: ['lite', 'full'] },
    cached: { type: 'boolean', description: 'A PASS receipt already proved this exact tree; nothing was re-run.' },
    claim: NULLABLE_STRING,
    git: { type: 'object' },
    checks: { type: 'array', items: CHECK_RESULT },
    skipped: { type: 'array', items: { type: 'object', properties: { id: STRING, cmd: STRING, reason: STRING }, required: ['id', 'cmd', 'reason'] } },
    integrity: {
      type: ['object', 'null'],
      description: 'Scan of the change set for weakened tests (deleted tests, new skips, dropped or downgraded assertions, neutered configuration).',
      properties: {
        mode: { type: 'string', enum: ['warn', 'strict', 'off'] },
        summary: { type: 'object' },
        testFiles: { type: 'integer' },
        findings: { type: 'array', items: { type: 'object' } },
        blocking: { type: 'integer', description: 'Findings that block in strict mode.' },
      },
    },
    stacks: STRINGS,
    notes: STRINGS,
    warnings: STRINGS,
    receipt: { type: ['object', 'null'], properties: { createdAt: STRING, status: STRING, profile: STRING, tree: STRING } },
    durationMs: { type: 'number' },
    version: STRING,
  },
  required: ['done', 'ok', 'noChecks', 'state', 'profile', 'cached', 'checks', 'skipped', 'integrity', 'receipt'],
};

const RECEIPT_OUTPUT = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['PASS', 'FAIL', 'STALE', 'NONE'] },
    done: { type: 'boolean', description: 'True only for a PASS receipt of a full run on exactly this tree.' },
    reason: STRING,
    root: STRING,
    tree: { type: 'string', description: 'Hash of the current working tree.' },
    receipt: {
      type: ['object', 'null'],
      properties: {
        createdAt: STRING,
        status: { type: 'string', enum: ['PASS', 'FAIL'] },
        profile: { type: 'string', enum: ['lite', 'full'] },
        tree: STRING,
        head: NULLABLE_STRING,
        branch: NULLABLE_STRING,
        claim: NULLABLE_STRING,
        host: NULLABLE_STRING,
        checks: { type: 'array', items: CHECK_RESULT },
      },
    },
  },
  required: ['state', 'done', 'reason', 'receipt'],
};

const DETECT_OUTPUT = {
  type: 'object',
  properties: {
    root: STRING,
    configSource: NULLABLE_STRING,
    stacks: STRINGS,
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: STRING,
          cmd: STRING,
          kind: { type: 'string', enum: ['lite', 'full'], description: 'lite = typecheck/lint, full = tests/build.' },
          source: STRING,
          timeoutSeconds: { type: 'number' },
          cwd: STRING,
        },
        required: ['id', 'cmd', 'kind', 'source', 'timeoutSeconds'],
      },
    },
    notes: STRINGS,
  },
  required: ['root', 'configSource', 'stacks', 'checks', 'notes'],
};

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  outputSchema: Json;
  annotations: Json;
}

/** In a fixed order: clients cache the list, and a stable list keeps the model's prompt cache warm. */
export const TOOLS: ToolDef[] = [
  {
    name: 'isitdone_verify',
    title: 'isitdone: verify before claiming done',
    description:
      "Run this repository's real test, typecheck and lint commands on the current working tree, scan the diff for weakened tests, and write a receipt bound to that exact tree. " +
      'Call it before you tell the user that work is complete, fixed, passing or ready for review, and paste the result. ' +
      'NOT DONE (done: false) is an answer, not a tool failure: fix the code and call again. Never skip, delete or weaken tests to make it pass. ' +
      'A PASS receipt for an unchanged tree is reused, so calling again is cheap.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROPERTY,
        profile: { type: 'string', enum: ['lite', 'full'], description: 'full (default) runs every check. lite runs only typecheck and lint and never reports done: true.' },
        claim: { type: 'string', description: 'The completion claim you are about to make, quoted; it is recorded in the receipt.' },
        base: { type: 'string', description: 'Git ref to diff against for the test-integrity scan. Default: HEAD, i.e. the uncommitted changes.' },
        strict: { type: 'boolean', description: 'Also answer NOT DONE when the change weakened tests (high or critical findings), even if the checks pass.' },
      },
    },
    outputSchema: VERIFY_OUTPUT,
    annotations: { title: 'isitdone: verify before claiming done', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'isitdone_receipt',
    title: 'isitdone: receipt for the current tree',
    description:
      'Read-only, runs nothing. Whether the current working tree already has a verification receipt: PASS (the checks passed on exactly this tree), FAIL, STALE (files or the check configuration changed since) or NONE.',
    inputSchema: { type: 'object', properties: { cwd: CWD_PROPERTY } },
    outputSchema: RECEIPT_OUTPUT,
    annotations: { title: 'isitdone: receipt for the current tree', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'isitdone_detect',
    title: 'isitdone: which checks would run',
    description: 'Read-only, runs nothing. The check commands isitdone_verify would run in this repository: id, command, lite or full, timeout, and where each one was detected.',
    inputSchema: { type: 'object', properties: { cwd: CWD_PROPERTY } },
    outputSchema: DETECT_OUTPUT,
    annotations: { title: 'isitdone: which checks would run', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
];

/** The tool list as the negotiated revision knows it: annotations arrived in 2025-03-26, title and outputSchema in 2025-06-18. */
export function toolsFor(version: string): Json[] {
  return TOOLS.map((t) => {
    const tool: Json = { name: t.name };
    if (version >= '2025-06-18') tool.title = t.title;
    tool.description = t.description;
    tool.inputSchema = t.inputSchema;
    if (version >= '2025-06-18') tool.outputSchema = t.outputSchema;
    if (version >= '2025-03-26') tool.annotations = t.annotations;
    return tool;
  });
}

/** The first `file://` root that exists on this machine, as a directory. Anything else in the list is skipped. */
export function firstFileRoot(roots: unknown): string | null {
  if (!Array.isArray(roots)) return null;
  for (const r of roots) {
    const uri = isObject(r) ? r.uri : null;
    if (typeof uri !== 'string' || !uri.toLowerCase().startsWith('file://')) continue;
    try {
      const p = fileURLToPath(uri);
      const st = statSync(p);
      return st.isDirectory() ? p : dirname(p);
    } catch {
      // a root from another machine (or another OS's path shape): try the next one
    }
  }
  return null;
}

export interface McpServerOptions {
  /** Writes one protocol message. */
  send: (message: Json) => void;
  /** Diagnostics (stderr). */
  log?: (line: string) => void;
  /** Directory used when neither the call nor the client names one. Default: process.cwd(). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  rootsTimeoutMs?: number;
}

export class McpServer {
  private readonly send: (message: Json) => void;
  private readonly log: (line: string) => void;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly rootsTimeoutMs: number;
  /** Set by `initialize`; scoped to this process, as the legacy revisions specify. */
  private legacy: { version: string; roots: boolean; clientName: string | null } | null = null;
  private rootsPromise: Promise<unknown[]> | null = null;
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  /** Requests being worked on, and the ones among them the client no longer wants an answer to. */
  private readonly active = new Set<Id>();
  private readonly cancelled = new Set<Id>();
  /** One verification at a time per project root. */
  private readonly flights = new Map<string, Flight>();
  private closed = false;

  constructor(opts: McpServerOptions) {
    this.send = opts.send;
    this.log = opts.log ?? (() => undefined);
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env ?? process.env;
    this.rootsTimeoutMs = opts.rootsTimeoutMs ?? ROOTS_TIMEOUT_MS;
  }

  /** One line of stdin. Never throws; every failure becomes a JSON-RPC error or a log line. */
  async handleLine(raw: string): Promise<void> {
    const line = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
    if (line === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error: the line is not valid JSON' } });
      return;
    }
    if (Array.isArray(msg)) {
      // JSON-RPC batches existed in 2025-03-26 only; answering them costs nothing.
      if (msg.length === 0) return this.write({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request: empty batch' } });
      const answers = (await Promise.all(msg.map((m) => this.handleMessage(m)))).filter((a): a is Json => a !== null);
      if (answers.length > 0) this.write(answers);
      return;
    }
    const answer = await this.handleMessage(msg);
    if (answer) this.write(answer);
  }

  /** The client is gone (stdin closed): kill running checks, drop what is queued, and let the process exit. */
  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('connection closed'));
    this.pending.clear();
    const running = [...this.flights.values()];
    for (const f of running) f.abort.abort();
    await Promise.allSettled(running.map((f) => f.promise));
  }

  private write(message: Json | Json[]): void {
    if (this.closed) return;
    this.send(message as Json);
  }

  private async handleMessage(msg: unknown): Promise<Json | null> {
    if (!isObject(msg) || msg.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request: expected a JSON-RPC 2.0 message' } };
    }
    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
    if (typeof msg.method !== 'string') {
      // A response to one of our own requests (roots/list).
      if (hasId && ('result' in msg || 'error' in msg)) {
        const waiter = this.pending.get(String(msg.id));
        this.pending.delete(String(msg.id));
        if (waiter && 'error' in msg) waiter.reject(new Error('the client answered with an error'));
        else if (waiter) waiter.resolve(msg.result);
        return null;
      }
      return { jsonrpc: '2.0', id: hasId ? msg.id : null, error: { code: INVALID_REQUEST, message: 'Invalid Request: no method' } };
    }
    const params = isObject(msg.params) ? msg.params : {};
    if (msg.id === undefined) {
      this.handleNotification(msg.method, params);
      return null;
    }
    if (!hasId) return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request: id must be a string or a number' } };
    const id = msg.id as Id;
    this.active.add(id);
    try {
      const result = await this.handleRequest(id, msg.method, params);
      // A cancelled request gets no answer at all.
      return this.cancelled.has(id) || result === null ? null : { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (this.cancelled.has(id)) return null;
      const rpc = err instanceof RpcFailure ? err.rpc : { code: INTERNAL_ERROR, message: `Internal error: ${(err as Error).message ?? String(err)}` };
      if (!(err instanceof RpcFailure)) this.log(`isitdone mcp: ${msg.method} failed: ${(err as Error).stack ?? String(err)}`);
      return { jsonrpc: '2.0', id, error: rpc };
    } finally {
      this.active.delete(id);
      this.cancelled.delete(id);
    }
  }

  private handleNotification(method: string, params: Json): void {
    if (method === 'notifications/initialized') {
      // Ask for the workspace roots now, so the first tool call does not have to wait for them.
      void this.legacyRoots();
    } else if (method === 'notifications/roots/list_changed') {
      this.rootsPromise = null;
    } else if (method === 'notifications/cancelled') {
      // Deliberately not a kill: clients cancel when their own tool timeout fires, and the model then calls again. The run
      // finishes within isitdone's per-check timeouts, the retry joins it (or finds its receipt), and the answer arrives
      // instead of a second timeout. The cancelled request itself is never answered.
      const id = params.requestId;
      if ((typeof id === 'string' || typeof id === 'number') && this.active.has(id)) this.cancelled.add(id);
    }
    // Every other notification is ignored; a notification never gets a response.
  }

  /** Which era and revision serves this request. */
  private context(method: string, params: Json): Ctx {
    const meta = isObject(params._meta) ? params._meta : {};
    const requested = meta[META_VERSION];
    if (requested !== undefined && method !== 'initialize') {
      if (typeof requested !== 'string') throw new RpcFailure({ code: INVALID_PARAMS, message: `Invalid params: _meta["${META_VERSION}"] must be a string` });
      if (MODERN_VERSIONS.includes(requested)) {
        const caps = meta[META_CLIENT_CAPS];
        if (!isObject(caps)) throw new RpcFailure({ code: INVALID_PARAMS, message: `Invalid params: _meta["${META_CLIENT_CAPS}"] is required on every request` });
        const info = meta[META_CLIENT_INFO];
        return { version: requested, modern: true, roots: isObject(caps.roots), clientName: isObject(info) && typeof info.name === 'string' ? info.name : null };
      }
      // A legacy revision named on a request is fine once the handshake negotiated exactly that one.
      if (!(this.legacy && this.legacy.version === requested)) {
        throw new RpcFailure({ code: UNSUPPORTED_PROTOCOL_VERSION, message: 'Unsupported protocol version', data: { supported: SUPPORTED_VERSIONS, requested } });
      }
    }
    // No per-request version: legacy semantics. A client that skipped the handshake is served with the newest legacy revision.
    return { version: this.legacy?.version ?? (LEGACY_VERSIONS[0] as string), modern: false, roots: this.legacy?.roots ?? false, clientName: this.legacy?.clientName ?? null };
  }

  /** Modern results say what they are and who sent them. */
  private wrap(ctx: Ctx, result: Json, cacheable = false): Json {
    if (!ctx.modern) return result;
    return { resultType: 'complete', ...result, ...(cacheable ? { ttlMs: CACHE_TTL_MS, cacheScope: 'public' } : {}), _meta: { [META_SERVER_INFO]: SERVER_INFO } };
  }

  private async handleRequest(id: Id, method: string, params: Json): Promise<Json | null> {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        // The client's revision when we speak it, else our newest one with a handshake; the client disconnects if it cannot.
        const version = LEGACY_VERSIONS.includes(requested) ? requested : (LEGACY_VERSIONS[0] as string);
        const caps = isObject(params.capabilities) ? params.capabilities : {};
        const info = isObject(params.clientInfo) ? params.clientInfo : {};
        this.legacy = { version, roots: isObject(caps.roots), clientName: typeof info.name === 'string' ? info.name : null };
        this.rootsPromise = null;
        return { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      }
      case 'server/discover': {
        const ctx = this.context(method, params);
        // Answered even without _meta: telling a confused client which versions exist is the point of the method.
        return this.wrap({ ...ctx, modern: true }, { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS }, true);
      }
      case 'ping':
        // Removed in 2026-07-28, but answering a keepalive is harmless.
        return this.wrap(this.context(method, params), {});
      case 'tools/list': {
        const ctx = this.context(method, params);
        return this.wrap(ctx, { tools: toolsFor(ctx.version) }, true);
      }
      case 'tools/call':
        return this.toolsCall(id, this.context(method, params), params);
      default:
        throw new RpcFailure({ code: METHOD_NOT_FOUND, message: `Method not found: ${method}` });
    }
  }

  private async toolsCall(id: Id, ctx: Ctx, params: Json): Promise<Json | null> {
    const name = params.name;
    if (typeof name !== 'string') throw new RpcFailure({ code: INVALID_PARAMS, message: 'Invalid params: name must be a string' });
    if (!TOOLS.some((t) => t.name === name)) throw new RpcFailure({ code: INVALID_PARAMS, message: `Unknown tool: ${name}` });
    if (params.arguments !== undefined && !isObject(params.arguments)) throw new RpcFailure({ code: INVALID_PARAMS, message: 'Invalid params: arguments must be an object' });
    const args = (params.arguments ?? {}) as Json;

    let outcome: ToolOutcome | RawResult | null;
    try {
      const dir = await this.resolveDir(ctx, params, args);
      if (typeof dir !== 'string') outcome = dir;
      else if (name === 'isitdone_verify') outcome = await this.toolVerify(id, ctx, params, args, dir);
      else if (name === 'isitdone_receipt') outcome = this.toolReceipt(dir);
      else outcome = this.toolDetect(dir);
    } catch (err) {
      if (err instanceof RpcFailure) throw err;
      // Bad arguments, a broken .isitdone.json, a git failure: the model can read these and react.
      outcome = { text: `isitdone: ${(err as Error).message ?? String(err)}`, isError: true };
    }
    if (outcome === null) return null;
    if ('raw' in outcome) return outcome.raw;
    const result: Json = { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError };
    // The text block is the report the model pastes to the user; programs read the same facts from structuredContent.
    if (outcome.structured && !outcome.isError && ctx.version >= '2025-06-18') result.structuredContent = outcome.structured;
    return this.wrap(ctx, result);
  }

  /** The directory a call is about: its `cwd` argument, else the client's first file:// root, else the server's cwd. */
  private async resolveDir(ctx: Ctx, params: Json, args: Json): Promise<string | RawResult> {
    if (args.cwd !== undefined && typeof args.cwd !== 'string') throw new ToolInputError('cwd must be a string (an absolute path)');
    if (typeof args.cwd === 'string' && args.cwd.trim() !== '') {
      const dir = resolve(this.cwd, args.cwd);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolInputError(`cwd is not a directory on this machine: ${dir}`);
      return dir;
    }
    if (!ctx.roots) return this.cwd;
    if (!ctx.modern) return firstFileRoot(await this.legacyRoots()) ?? this.cwd;
    // 2026-07-28 has no server-to-client requests: ask through an input_required result, once, and take the retry as it comes.
    const responses = isObject(params.inputResponses) ? params.inputResponses : null;
    if (!responses && params.requestState !== ROOTS_STATE) {
      return { raw: this.wrap(ctx, { resultType: 'input_required', inputRequests: { roots: { method: 'roots/list' } }, requestState: ROOTS_STATE }) };
    }
    const answer = responses && isObject(responses.roots) ? responses.roots.roots : null;
    return firstFileRoot(answer) ?? this.cwd;
  }

  /** Legacy eras: one `roots/list` request to the client, cached until it says the list changed. Never rejects. */
  private legacyRoots(): Promise<unknown[]> {
    if (!this.legacy?.roots || this.closed) return Promise.resolve([]);
    this.rootsPromise ??= this.request('roots/list').then(
      (r) => (isObject(r) && Array.isArray(r.roots) ? r.roots : []),
      (err: Error) => {
        this.log(`isitdone mcp: roots/list: ${err.message}; using ${this.cwd}`);
        return [];
      },
    );
    return this.rootsPromise;
  }

  private request(method: string): Promise<unknown> {
    const id = `isitdone-${++this.seq}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer within ${this.rootsTimeoutMs}ms`));
      }, this.rootsTimeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolveRequest(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write({ jsonrpc: '2.0', id, method });
    });
  }

  /**
   * One verification at a time per project root. A second call asking the same question gets the answer of the run in
   * flight; a different question (another profile, base or strictness) waits its turn, and usually finds a fresh receipt.
   */
  private async exclusive(root: string, key: string, run: (signal: AbortSignal) => Promise<VerifyResult>): Promise<VerifyResult | null> {
    for (;;) {
      const current = this.flights.get(root);
      if (!current) break;
      if (current.key === key) return current.promise;
      await current.promise.catch(() => undefined);
    }
    if (this.closed) return null;
    const abort = new AbortController();
    const flight: Flight = { key, abort, promise: Promise.resolve(null) };
    flight.promise = run(abort.signal).finally(() => {
      if (this.flights.get(root) === flight) this.flights.delete(root);
    });
    this.flights.set(root, flight);
    return flight.promise;
  }

  private async toolVerify(id: Id, ctx: Ctx, params: Json, args: Json, dir: string): Promise<ToolOutcome | null> {
    // Same guard as the CLI: a check that itself reaches isitdone (a Makefile target, a test that spawns an agent) must not recurse.
    if (this.env.ISITDONE === '1') {
      return { text: 'isitdone: refusing to run nested inside an isitdone check (remove isitdone from that check command, or disable the check in .isitdone.json)', isError: true };
    }
    if (args.profile !== undefined && args.profile !== 'lite' && args.profile !== 'full') throw new ToolInputError(`profile must be "lite" or "full" (got ${JSON.stringify(args.profile)})`);
    for (const key of ['claim', 'base'] as const) {
      if (args[key] !== undefined && typeof args[key] !== 'string') throw new ToolInputError(`${key} must be a string`);
    }
    if (args.strict !== undefined && typeof args.strict !== 'boolean') throw new ToolInputError('strict must be true or false');
    const profile = args.profile === 'lite' ? 'lite' : 'full';
    const claim = typeof args.claim === 'string' && args.claim.trim() !== '' ? args.claim.trim() : null;
    const base = typeof args.base === 'string' && args.base.trim() !== '' ? args.base.trim() : undefined;
    const strict = args.strict === true;

    const root = findRoot(dir);
    const { config } = loadConfig(root);

    // Progress keeps clients with a resetting tool timeout waiting through a slow suite. Only for the request that asked.
    const meta = isObject(params._meta) ? params._meta : {};
    const token = typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number' ? meta.progressToken : null;
    let progress = 0;
    const tell = (message: string) => {
      if (token === null || this.cancelled.has(id)) return;
      this.write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++progress, ...(ctx.version >= '2025-03-26' ? { message } : {}) } });
    };
    let heartbeat: NodeJS.Timeout | null = null;
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };

    const res = await this.exclusive(root, JSON.stringify([profile, base ?? null, strict]), (signal) =>
      verify({
        root,
        config: strict ? { ...config, integrity: 'strict' } : config,
        profile,
        claim,
        host: ctx.clientName ? `mcp:${ctx.clientName.replace(/[^\x20-\x7e]/g, '').slice(0, 60)}` : 'mcp',
        base,
        signal,
        onCheckStart: (check) => {
          const started = Date.now();
          tell(`running ${check.cmd}`);
          stopHeartbeat();
          heartbeat = setInterval(() => tell(`still running ${check.cmd} (${formatDuration(Date.now() - started)})`), HEARTBEAT_MS);
          heartbeat.unref();
        },
        onCheckDone: stopHeartbeat,
      }).finally(stopHeartbeat),
    );
    if (res === null || this.closed) return null;

    const state = receiptStateOf(res);
    const json = toJson(res, state);
    // Thirty lines of a passing check's output are noise to a model; the failing tails are the point, with minified
    // one-liners clipped so a single result cannot flood the context.
    const checks = (json.checks as Array<{ status: string; tail: string[] }>).map((c) => ({ ...c, tail: c.status === 'PASS' ? [] : c.tail.map(clip) }));
    const structured: Json = { ...json, checks };
    const report = formatReport(res, plain).split('\n').map(clip).join('\n');
    return { text: `${report}\n\n${adviceFor(res, json.done === true)}`, structured, isError: false };
  }

  private toolReceipt(dir: string): ToolOutcome {
    const root = findRoot(dir);
    const git = gitInfo(root);
    const ev = evaluateReceipt(root, git, configHash(root));
    const done = ev.state === 'PASS' && ev.receipt?.profile === 'full';
    const r = ev.receipt;
    const receipt = r
      ? {
          createdAt: r.createdAt,
          status: r.status,
          profile: r.profile,
          tree: r.tree,
          head: r.head,
          branch: r.branch,
          claim: r.claim,
          host: r.host,
          checks: r.checks.map((c) => ({ id: c.id, cmd: c.cmd, status: c.status, exitCode: c.exitCode, durationMs: c.durationMs, summary: c.summary ?? null, tail: c.status === 'PASS' ? [] : c.tail.map(clip) })),
        }
      : null;
    const advice = done ? 'This exact tree is verified.' : 'This tree is not verified. Call isitdone_verify before telling the user the work is complete.';
    return {
      text: `${formatReceiptState(ev, plain, 'call isitdone_verify with profile "full"')}\n\n${advice}`,
      structured: { state: ev.state, done, reason: ev.reason, root, tree: git.tree, receipt },
      isError: false,
    };
  }

  private toolDetect(dir: string): ToolOutcome {
    const root = findRoot(dir);
    const { config, source } = loadConfig(root);
    const d = detectChecks(root, config);
    const checks = d.checks.map((c) => ({ id: c.id, cmd: c.cmd, kind: c.kind, source: c.source, timeoutSeconds: timeoutFor(c, config) / 1000, ...(c.cwd ? { cwd: c.cwd } : {}) }));
    return { text: formatDetection(root, d, config, source, plain), structured: { root, configSource: source, stacks: d.stacks, checks, notes: d.notes }, isError: false };
  }
}

/** The closing lines of a verify result: what the model should do with it. */
function adviceFor(res: VerifyResult, done: boolean): string {
  if (done) return 'Verified. Paste this result when you tell the user the work is complete.';
  if (res.detection.checks.length === 0) {
    return 'NOT VERIFIED: no checks were detected, so nothing proves the work is done. Do not tell the user it is verified; say which commands you ran yourself, or define checks in .isitdone.json.';
  }
  if (res.ok && integrityBlocks(res)) {
    return 'Restore the removed or weakened tests (or explain to the user why the change to the tests is correct), then call isitdone_verify again before telling the user the work is complete.';
  }
  if (res.ok && res.profile === 'lite') return 'Only the lite checks (typecheck, lint) ran, so this is not "done" yet. Call isitdone_verify with profile "full" before telling the user the work is complete.';
  if (res.ok) return 'The checks passed, but no receipt could be written for this tree (see the warning above), so it is not recorded as verified. Tell the user about the warning.';
  return 'Fix the failures, then call isitdone_verify again before telling the user the work is complete. Do not skip, delete or weaken tests to make this pass; if a check is wrong for this repo, say so explicitly to the user.';
}

/**
 * Serve MCP on this process's stdin/stdout until stdin closes. Resolves with the exit code; never calls process.exit,
 * so answers still in the pipe are flushed.
 */
export function runMcpServer(opts: { cwd?: string } = {}): Promise<number> {
  return new Promise((done) => {
    const log = (line: string) => process.stderr.write(line + '\n');
    // stdout belongs to the protocol. Keep the real writer for it, and point everything else in this process that might
    // print (a stray console.log, a dependency of tomorrow) at stderr. Checks never inherit stdout: they run on pipes.
    const protocol = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;
    process.stdout.write = ((...a: Parameters<typeof process.stderr.write>) => process.stderr.write(...a)) as typeof process.stdout.write;

    const server = new McpServer({ send: (message) => protocol(JSON.stringify(message) + '\n'), log: process.env.ISITDONE_DEBUG ? log : undefined, cwd: opts.cwd });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      // If a killed check still pins the event loop, leave anyway; unref'd, so a clean exit never waits for it.
      setTimeout(() => process.exit(0), 5000).unref();
      void server.close().then(() => done(0));
    };

    if (process.stdin.isTTY) log('isitdone mcp: serving the Model Context Protocol on stdio. An MCP client starts this command; see "MCP server" in the README. Ctrl+C to quit.');
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        void server.handleLine(line);
      }
    });
    process.stdin.on('end', () => {
      // A last message without a newline still counts; one turn of the loop lets a quick answer out before the door shuts.
      void server.handleLine(buffer);
      setImmediate(finish);
    });
    process.stdin.on('error', finish);
    // The client died without closing stdin politely.
    process.stdout.on('error', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}
