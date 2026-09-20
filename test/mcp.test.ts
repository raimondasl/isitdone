import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { firstFileRoot, LEGACY_VERSIONS, McpServer, SUPPORTED_VERSIONS, toolsFor } from '../src/mcp.js';
import { FAIL, PASS, SLOW, nodePkg, tempRepo, type TempRepo } from './helpers.js';

// Own bundle path so this file never races cli.test.ts, which builds into test/.build/isitdone.js.
const BUNDLE = resolve('test/.build/isitdone-mcp.js');

type Json = Record<string, any>;

/** Windows CI reports the temp dir with an 8.3 short name (RUNNER~1); the server answers with the canonical long form. */
const real = (p: string | null | undefined): string => realpathSync.native(p ?? '');

const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  caps: 'io.modelcontextprotocol/clientCapabilities',
  client: 'io.modelcontextprotocol/clientInfo',
  server: 'io.modelcontextprotocol/serverInfo',
};
const modern = (caps: Json = {}, version = '2026-07-28') => ({ [META.version]: version, [META.caps]: caps, [META.client]: { name: 'vitest-modern', version: '1' } });

/** Prints to stdout and stderr before failing: none of it may reach the server's own stdout. */
const NOISY_FAIL = 'node -e "console.log(\'NOISE-ON-STDOUT\'); console.log(\'L\'.repeat(5000)); console.error(\'NOISE-ON-STDERR\'); console.log(\'1 failed, 2 passed\'); process.exit(1)"';
/** Leaves a mark outside the repo each time it runs, takes a moment, and fails (so no receipt is ever reused). */
const COUNTED_FAIL = 'node -e "require(\'fs\').appendFileSync(process.env.ISITDONE_TEST_COUNTER, \'x\'); setTimeout(function () { process.exit(1); }, 1500)"';

/** A minimal MCP client over the spawned server's stdio. It keeps every raw stdout line for the "protocol only" assertions. */
class Client {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  readonly notifications: Json[] = [];
  readonly serverRequests: Json[] = [];
  stderr = '';
  private buffer = '';
  private seq = 0;
  private readonly waiting = new Map<string | number, (msg: Json) => void>();
  private readonly watchers: Array<() => void> = [];
  readonly exited: Promise<number | null>;

  /** `roots`: answer the server's roots/list with these directories (undefined = never answer). */
  constructor(cwd: string, opts: { env?: Record<string, string>; roots?: string[] } = {}) {
    this.proc = spawn(process.execPath, [BUNDLE, 'mcp'], { cwd, env: { ...process.env, NO_COLOR: '1', ISITDONE_DEBUG: '', ...opts.env }, windowsHide: true });
    this.exited = new Promise((done) => this.proc.on('close', (code) => done(code)));
    this.proc.stderr.on('data', (d: Buffer) => (this.stderr += d.toString('utf8')));
    this.proc.stdout.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf8');
      for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        this.lines.push(line);
        let msg: Json;
        try {
          msg = JSON.parse(line) as Json;
        } catch {
          continue; // the protocol-only assertion reports it
        }
        if (typeof msg.method === 'string' && msg.id !== undefined) {
          this.serverRequests.push(msg);
          if (msg.method === 'roots/list' && opts.roots) this.send({ jsonrpc: '2.0', id: msg.id, result: { roots: opts.roots.map((r) => ({ uri: pathToFileURL(r).href, name: 'repo' })) } });
        } else if (typeof msg.method === 'string') this.notifications.push(msg);
        else if (msg.id !== undefined && msg.id !== null) this.waiting.get(msg.id)?.(msg);
        else this.waiting.get('null')?.(msg);
        for (const w of this.watchers.splice(0)) w();
      }
    });
  }

  send(message: Json | string): void {
    this.proc.stdin.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n');
  }

  /** Send a request and wait for the message that answers it. */
  request(method: string, params?: Json, id: string | number = ++this.seq): Promise<Json> {
    return new Promise((done) => {
      this.waiting.set(id, done);
      this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  }

  /** The next message with `id: null` (parse errors, invalid requests). */
  nextIdless(): Promise<Json> {
    return new Promise((done) => this.waiting.set('null', done));
  }

  async until(cond: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting; stdout so far:\n${this.lines.join('\n')}\nstderr:\n${this.stderr}`);
      await new Promise<void>((next) => {
        const t = setTimeout(next, 250);
        this.watchers.push(() => {
          clearTimeout(t);
          next();
        });
      });
    }
  }

  async initialize(protocolVersion = '2025-06-18', capabilities: Json = {}): Promise<Json> {
    const r = await this.request('initialize', { protocolVersion, capabilities, clientInfo: { name: 'vitest', version: '1' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }

  call(name: string, args: Json = {}, extra: Json = {}): Promise<Json> {
    return this.request('tools/call', { name, arguments: args, ...extra });
  }

  /** Close stdin, the way a client shuts a stdio server down, and wait for the exit code. */
  close(): Promise<number | null> {
    this.proc.stdin.end();
    return this.exited;
  }
}

/** Just enough JSON Schema (type, enum, required, properties, items) to hold structuredContent to its outputSchema. */
function violations(value: unknown, schema: Json, path = '$'): string[] {
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);
  const types: string[] | null = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  const t = typeOf(value);
  if (types && !types.includes(t) && !(t === 'integer' && types.includes('number'))) return [`${path}: ${t} is not ${types.join('|')}`];
  const out: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (t === 'object') {
    const obj = value as Json;
    for (const key of schema.required ?? []) if (!(key in obj)) out.push(`${path}.${key}: required`);
    for (const [key, sub] of Object.entries((schema.properties ?? {}) as Json)) if (key in obj) out.push(...violations(obj[key], sub as Json, `${path}.${key}`));
  }
  if (t === 'array' && schema.items) (value as unknown[]).forEach((v, i) => out.push(...violations(v, schema.items, `${path}[${i}]`)));
  return out;
}

let repo: TempRepo | null = null;
let elsewhere: TempRepo | null = null;
let client: Client | null = null;
afterEach(async () => {
  if (client && client.proc.exitCode === null) {
    client.proc.stdin.end();
    const gone = await Promise.race([client.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
    if (!gone) client.proc.kill();
  }
  client = null;
  repo?.cleanup();
  elsewhere?.cleanup();
  repo = null;
  elsewhere = null;
});

beforeAll(async () => {
  const { build } = await import('esbuild');
  await build({
    entryPoints: ['src/cli.ts'],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    define: { __VERSION__: '"0.0.0-test"' },
    logLevel: 'silent',
  });
}, 60_000);

describe('isitdone mcp (spawned server)', () => {
  it('handshake, tools/list, verify NOT DONE then DONE; stdout carries nothing but JSON-RPC even when a check prints', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: NOISY_FAIL, lint: PASS }) } });
    client = new Client(repo.root);

    const init = await client.initialize('2025-06-18');
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo).toEqual({ name: 'isitdone', version: '0.0.0-test' });
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(init.result.instructions).toMatch(/call isitdone_verify/);
    expect(init.result.instructions).toMatch(/paste its result/);
    expect(init.result.instructions).toMatch(/Never skip, delete, loosen or otherwise weaken tests/);

    const list = await client.request('tools/list');
    const tools = list.result.tools as Json[];
    expect(tools.map((t) => t.name)).toEqual(['isitdone_verify', 'isitdone_receipt', 'isitdone_detect']);
    const verifyTool = tools[0] as Json;
    expect(Object.keys(verifyTool.inputSchema.properties)).toEqual(['cwd', 'profile', 'claim', 'base', 'strict']);
    expect(verifyTool.inputSchema.properties.profile.enum).toEqual(['lite', 'full']);
    expect(verifyTool.inputSchema.type).toBe('object');
    for (const t of tools) expect(t.outputSchema.type).toBe('object');
    expect(list.result.resultType).toBeUndefined(); // a 2026-07-28 field; legacy results do not carry it

    const bad = await client.call('isitdone_verify', { claim: 'All tests pass.' });
    expect(bad.result.isError).toBe(false); // NOT DONE is a result, not a tool failure
    const text = bad.result.content[0].text as string;
    expect(bad.result.content[0].type).toBe('text');
    expect(text).toMatch(/npm test\s+FAIL\s+\S+\s+1 failed, 2 passed/);
    expect(text).toMatch(/NOT DONE {3}1 check failed/);
    expect(text).toMatch(/NOISE-ON-STDOUT/); // the failing tail is part of the report
    expect(text).toMatch(/call isitdone_verify again before telling the user/);
    expect(text).toMatch(/Do not skip, delete or weaken tests/);
    const s = bad.result.structuredContent as Json;
    expect(violations(s, verifyTool.outputSchema)).toEqual([]);
    expect(s.done).toBe(false);
    expect(s.state).toBe('FAIL');
    expect(s.claim).toBe('All tests pass.');
    expect(s.checks.map((c: Json) => `${c.id}:${c.status}`)).toEqual(['lint:PASS', 'test:FAIL']);
    expect(s.checks[0].tail).toEqual([]); // passing output is noise
    expect(s.checks[1].tail).toContain('NOISE-ON-STDERR');
    // A minified one-liner in the output is clipped, in the report and in the structured tail.
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThanOrEqual(420);
    expect(Math.max(...s.checks[1].tail.map((l: string) => l.length))).toBe(400);
    expect(s.integrity.mode).toBe('warn');
    expect(s.integrity.findings).toEqual([]);

    const failed = await client.call('isitdone_receipt');
    expect(failed.result.structuredContent.state).toBe('FAIL');
    expect(failed.result.structuredContent.done).toBe(false);
    expect(violations(failed.result.structuredContent, (tools[1] as Json).outputSchema)).toEqual([]);
    expect(failed.result.content[0].text).toMatch(/isitdone receipt {2}FAIL/);

    repo.write('package.json', nodePkg({ test: PASS, lint: PASS }));
    const stale = await client.call('isitdone_receipt');
    expect(stale.result.structuredContent.state).toBe('STALE');

    const good = await client.call('isitdone_verify', { claim: 'Fixed.' });
    expect(good.result.isError).toBe(false);
    expect(good.result.structuredContent.done).toBe(true);
    expect(good.result.structuredContent.state).toBe('PASS');
    expect(good.result.structuredContent.cached).toBe(false);
    expect(violations(good.result.structuredContent, verifyTool.outputSchema)).toEqual([]);
    expect(good.result.content[0].text).toMatch(/DONE {3}receipt -> PASS/);
    expect(good.result.content[0].text).toMatch(/Paste this result/);

    const again = await client.call('isitdone_verify');
    expect(again.result.structuredContent.cached).toBe(true);
    expect(again.result.structuredContent.done).toBe(true);
    const pass = await client.call('isitdone_receipt');
    expect(pass.result.structuredContent).toMatchObject({ state: 'PASS', done: true });
    expect(pass.result.structuredContent.receipt.host).toBe('mcp:vitest');
    expect(pass.result.structuredContent.receipt.hmac).toBeUndefined();

    const detect = await client.call('isitdone_detect');
    expect(detect.result.structuredContent.checks.map((c: Json) => c.cmd)).toEqual(['npm run lint', 'npm test']);
    expect(violations(detect.result.structuredContent, (tools[2] as Json).outputSchema)).toEqual([]);
    expect(detect.result.content[0].text).toMatch(/isitdone detect/);

    expect(await client.close()).toBe(0);
    // Every line the server ever wrote to stdout is one JSON-RPC 2.0 message.
    expect(client.lines).toHaveLength(9); // one answer per request, nothing else
    for (const line of client.lines) {
      const msg = JSON.parse(line) as Json;
      expect(msg.jsonrpc).toBe('2.0');
      expect('result' in msg || 'error' in msg || 'method' in msg).toBe(true);
    }
    expect(client.serverRequests).toEqual([]); // no roots capability, no roots/list
  }, 120_000);

  it('negotiates the protocol version and shapes the tools to the revision', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    client = new Client(repo.root);
    for (const v of LEGACY_VERSIONS) expect((await client.initialize(v)).result.protocolVersion).toBe(v);
    // A revision we do not speak (or a stateless one, which has no handshake) gets our newest revision that has one.
    expect((await client.initialize('2099-01-01')).result.protocolVersion).toBe('2025-11-25');
    expect((await client.initialize('2026-07-28')).result.protocolVersion).toBe('2025-11-25');
    expect((await client.request('initialize', {})).result.protocolVersion).toBe('2025-11-25');

    await client.initialize('2024-11-05');
    const oldest = (await client.request('tools/list')).result.tools[0] as Json;
    expect(Object.keys(oldest)).toEqual(['name', 'description', 'inputSchema']);
    const oldCall = await client.call('isitdone_detect');
    expect(oldCall.result.structuredContent).toBeUndefined();
    expect(oldCall.result.content[0].text).toMatch(/npm test/); // the text block is always there

    await client.initialize('2025-03-26');
    expect(Object.keys((await client.request('tools/list')).result.tools[0] as Json)).toEqual(['name', 'description', 'inputSchema', 'annotations']);
    expect((await client.call('isitdone_detect')).result.structuredContent).toBeUndefined();

    await client.initialize('2025-11-25');
    const newest = (await client.request('tools/list')).result.tools as Json[];
    expect(Object.keys(newest[0] as Json)).toEqual(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations']);
    expect((newest[0] as Json).annotations.readOnlyHint).toBe(false);
    expect((newest[1] as Json).annotations.readOnlyHint).toBe(true);
    expect(real((await client.call('isitdone_detect')).result.structuredContent.root)).toBe(real(repo.root));
  }, 60_000);

  it('ping, unknown method, garbage, invalid requests, notifications, unknown tool, bad arguments', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    client = new Client(repo.root);
    await client.initialize();

    expect((await client.request('ping')).result).toEqual({});
    expect((await client.request('ping', undefined, 'string-id')).id).toBe('string-id');

    const unknown = await client.request('resources/list');
    expect(unknown.error.code).toBe(-32601);
    expect(unknown.error.message).toMatch(/resources\/list/);

    let idless = client.nextIdless();
    client.send('this is {not json');
    expect(await idless).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    idless = client.nextIdless();
    client.send({ id: 7, method: 'ping' }); // no jsonrpc member
    expect((await idless).error.code).toBe(-32600);
    idless = client.nextIdless();
    client.send('[]');
    expect((await idless).error.code).toBe(-32600);
    client.send(''); // blank lines are ignored
    client.send('\r');

    // Notifications never get an answer, known or not.
    const before = client.lines.length;
    client.send({ jsonrpc: '2.0', method: 'notifications/whatever', params: { a: 1 } });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 12345 } });
    expect((await client.request('ping')).result).toEqual({});
    expect(client.lines.length).toBe(before + 1);

    // A JSON-RPC batch (2025-03-26) is answered as one array line.
    const batchSeen = client.until(() => client!.lines.some((l) => l.startsWith('[')));
    client.send(JSON.stringify([{ jsonrpc: '2.0', id: 'b1', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b2', method: 'nope' }]));
    await batchSeen;
    const batch = JSON.parse(client.lines.find((l) => l.startsWith('[')) as string) as Json[];
    expect(batch.map((m) => m.id).sort()).toEqual(['b1', 'b2']);

    const noTool = await client.call('isitdone_bogus');
    expect(noTool.error).toMatchObject({ code: -32602, message: 'Unknown tool: isitdone_bogus' });
    expect((await client.request('tools/call', { name: 'isitdone_detect', arguments: 'nope' })).error.code).toBe(-32602);

    // Bad arguments come back as tool errors the model can read and correct.
    const badProfile = await client.call('isitdone_verify', { profile: 'medium' });
    expect(badProfile.result.isError).toBe(true);
    expect(badProfile.result.content[0].text).toMatch(/profile must be "lite" or "full"/);
    expect(badProfile.result.structuredContent).toBeUndefined();
    const badCwd = await client.call('isitdone_detect', { cwd: join(repo.root, 'does-not-exist') });
    expect(badCwd.result.isError).toBe(true);
    expect(badCwd.result.content[0].text).toMatch(/not a directory/);
    expect((await client.call('isitdone_verify', { strict: 'yes' })).result.isError).toBe(true);

    // A broken config is a tool error too, not a dead server.
    repo.write('.isitdone.json', '{ nope');
    const broken = await client.call('isitdone_verify');
    expect(broken.result.isError).toBe(true);
    expect(broken.result.content[0].text).toMatch(/Could not parse \.isitdone\.json/);
    expect((await client.request('ping')).result).toEqual({});

    expect(await client.close()).toBe(0);
    for (const line of client.lines) expect(() => JSON.parse(line)).not.toThrow();
  }, 60_000);

  it('lite profile, strict mode and an explicit cwd', async () => {
    repo = tempRepo({
      files: {
        'package.json': nodePkg({ test: PASS, lint: PASS }),
        'a.test.js': "test('a', () => { expect(1).toBe(1); });\ntest('b', () => { expect(2).toBe(2); });\n",
      },
    });
    elsewhere = tempRepo({ git: false });
    client = new Client(elsewhere.root);
    await client.initialize('2025-11-25');

    // Started somewhere without checks: the default cwd finds nothing, and says that nothing is verified.
    const nothing = await client.call('isitdone_verify');
    expect(nothing.result.structuredContent).toMatchObject({ done: false, noChecks: true, state: 'NONE' });
    expect(nothing.result.content[0].text).toMatch(/NOT VERIFIED: no checks were detected/);

    const lite = await client.call('isitdone_verify', { cwd: repo.root, profile: 'lite' });
    expect(lite.result.structuredContent).toMatchObject({ ok: true, done: false, profile: 'lite' });
    expect(lite.result.structuredContent.checks.map((c: Json) => c.id)).toEqual(['lint']);
    expect(lite.result.content[0].text).toMatch(/OK \(lite\)/);
    expect(lite.result.content[0].text).toMatch(/profile "full"/);
    // Reusing the lite receipt is still not "DONE".
    const liteAgain = await client.call('isitdone_verify', { cwd: repo.root, profile: 'lite' });
    expect(liteAgain.result.structuredContent).toMatchObject({ cached: true, done: false });
    expect(liteAgain.result.content[0].text).not.toMatch(/\bDONE\b/);

    // The agent "fixes" a failure by skipping the test: the checks pass, strict mode still says NOT DONE.
    repo.write('a.test.js', "test('a', () => { expect(1).toBe(1); });\ntest.skip('b', () => { expect(2).toBe(2); });\n");
    const warn = await client.call('isitdone_verify', { cwd: repo.root });
    expect(warn.result.structuredContent.done).toBe(true);
    expect(warn.result.structuredContent.integrity.findings.length).toBeGreaterThan(0);
    const strict = await client.call('isitdone_verify', { cwd: repo.root, strict: true });
    expect(strict.result.isError).toBe(false);
    expect(strict.result.structuredContent).toMatchObject({ done: false, ok: false });
    expect(strict.result.structuredContent.integrity.mode).toBe('strict');
    expect(strict.result.structuredContent.integrity.blocking).toBeGreaterThan(0);
    expect(strict.result.content[0].text).toMatch(/Restore the removed or weakened tests/);

    // base: diff against a ref instead of the uncommitted changes.
    repo.commit('skip b');
    const based = await client.call('isitdone_verify', { cwd: repo.root, base: 'HEAD~1', strict: true });
    expect(based.result.structuredContent.integrity.blocking).toBeGreaterThan(0);
    expect((await client.call('isitdone_verify', { cwd: repo.root, strict: true })).result.structuredContent.done).toBe(true);
  }, 120_000);

  it('2026-07-28: stateless requests, server/discover, per-request _meta, resultType, roots through input_required', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    elsewhere = tempRepo({ git: false });
    client = new Client(elsewhere.root);

    // No handshake at all.
    const discover = await client.request('server/discover', { _meta: modern() });
    expect(discover.result).toMatchObject({ resultType: 'complete', supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, cacheScope: 'public' });
    expect(discover.result.supportedVersions[0]).toBe('2026-07-28');
    expect(discover.result.ttlMs).toBeGreaterThan(0);
    expect(discover.result.instructions).toMatch(/isitdone_verify/);
    expect(discover.result._meta[META.server]).toEqual({ name: 'isitdone', version: '0.0.0-test' });
    // The stdio probe of a confused client still learns the versions.
    expect((await client.request('server/discover')).result.supportedVersions).toEqual(SUPPORTED_VERSIONS);

    const list = await client.request('tools/list', { _meta: modern() });
    expect(list.result).toMatchObject({ resultType: 'complete', cacheScope: 'public' });
    expect(list.result.ttlMs).toBeGreaterThan(0);
    expect(list.result.tools.map((t: Json) => t.name)).toEqual(['isitdone_verify', 'isitdone_receipt', 'isitdone_detect']);
    expect(list.result.tools[0].outputSchema).toBeDefined();

    const unsupported = await client.request('tools/list', { _meta: modern({}, '1999-01-01') });
    expect(unsupported.error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED_VERSIONS, requested: '1999-01-01' } });
    // A handshake revision named on a request, without a handshake, is not something we can serve either.
    expect((await client.request('tools/list', { _meta: modern({}, '2025-06-18') })).error.code).toBe(-32022);
    expect((await client.request('server/discover', { _meta: modern({}, '2030-01-01') })).error.code).toBe(-32022);
    // clientCapabilities is required on every modern request.
    expect((await client.request('tools/list', { _meta: { [META.version]: '2026-07-28' } })).error.code).toBe(-32602);

    const verified = await client.call('isitdone_verify', { cwd: repo.root }, { _meta: modern() });
    expect(verified.result).toMatchObject({ resultType: 'complete', isError: false });
    expect(verified.result.structuredContent.done).toBe(true);
    expect(verified.result._meta[META.server].name).toBe('isitdone');
    expect((await client.call('isitdone_receipt', { cwd: repo.root }, { _meta: modern() })).result.structuredContent.receipt.host).toBe('mcp:vitest-modern');

    // No cwd and a client with roots: the server asks through the result, the client retries with the answer.
    const ask = await client.call('isitdone_detect', {}, { _meta: modern({ roots: {} }) });
    expect(ask.result.resultType).toBe('input_required');
    expect(ask.result.inputRequests).toEqual({ roots: { method: 'roots/list' } });
    expect(typeof ask.result.requestState).toBe('string');
    const retried = await client.call('isitdone_detect', {}, {
      _meta: modern({ roots: {} }),
      inputResponses: { roots: { roots: [{ uri: 'https://example.com/not-a-file' }, { uri: pathToFileURL(repo.root).href }] } },
      requestState: ask.result.requestState,
    });
    expect(retried.result.resultType).toBe('complete');
    expect(real(retried.result.structuredContent.root)).toBe(real(repo.root));
    // A retry without the answer is served from the server's own directory instead of asking forever.
    const shrug = await client.call('isitdone_detect', {}, { _meta: modern({ roots: {} }), requestState: ask.result.requestState });
    expect(real(shrug.result.structuredContent.root)).toBe(real(elsewhere.root));
    // An explicit cwd never needs the round trip; neither does a client without roots.
    expect((await client.call('isitdone_detect', { cwd: repo.root }, { _meta: modern({ roots: {} }) })).result.resultType).toBe('complete');
    expect(real((await client.call('isitdone_detect', {}, { _meta: modern() })).result.structuredContent.root)).toBe(real(elsewhere.root));

    expect(client.serverRequests).toEqual([]); // 2026-07-28 forbids server-to-client requests
    expect(await client.close()).toBe(0);
  }, 60_000);

  it('legacy roots: asks the client for roots/list and prefers the first file:// root over its own cwd', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    elsewhere = tempRepo({ git: false });
    client = new Client(elsewhere.root, { roots: [repo.root] });
    await client.initialize('2025-06-18', { roots: { listChanged: true } });
    const detect = await client.call('isitdone_detect');
    expect(real(detect.result.structuredContent.root)).toBe(real(repo.root));
    expect(client.serverRequests.map((r) => r.method)).toEqual(['roots/list']);
    // Cached until the client says the list changed.
    await client.call('isitdone_detect');
    expect(client.serverRequests).toHaveLength(1);
    client.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    await client.call('isitdone_detect');
    expect(client.serverRequests).toHaveLength(2);
    // The argument still wins.
    expect(real((await client.call('isitdone_detect', { cwd: elsewhere.root })).result.structuredContent.root)).toBe(real(elsewhere.root));
  }, 60_000);

  it('one verification at a time per repo: a concurrent identical call gets the in-flight result', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: COUNTED_FAIL }) } });
    elsewhere = tempRepo({ git: false });
    const counter = join(elsewhere.root, 'runs.txt');
    client = new Client(repo.root, { env: { ISITDONE_TEST_COUNTER: counter } });
    await client.initialize();
    const [a, b] = await Promise.all([client.call('isitdone_verify', { claim: 'first' }), client.call('isitdone_verify', { claim: 'second' })]);
    expect(readFileSync(counter, 'utf8')).toBe('x');
    expect(a.result.structuredContent.done).toBe(false);
    expect(b.result.structuredContent.durationMs).toBe(a.result.structuredContent.durationMs); // the same run
    // A different question waits its turn instead of running beside it.
    const [c, d] = await Promise.all([client.call('isitdone_verify'), client.call('isitdone_verify', { profile: 'lite' })]);
    expect(readFileSync(counter, 'utf8')).toBe('xx');
    expect(c.result.structuredContent.profile).toBe('full');
    expect(d.result.structuredContent.profile).toBe('lite');
  }, 120_000);

  it('a cancelled call is never answered, but its run finishes and the retry joins it', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: COUNTED_FAIL }) } });
    elsewhere = tempRepo({ git: false });
    const counter = join(elsewhere.root, 'runs.txt');
    client = new Client(repo.root, { env: { ISITDONE_TEST_COUNTER: counter } });
    await client.initialize('2025-11-25');
    client.send({ jsonrpc: '2.0', id: 'gave-up', method: 'tools/call', params: { name: 'isitdone_verify', arguments: {}, _meta: { progressToken: 'p1' } } });
    await client.until(() => client!.notifications.some((n) => n.method === 'notifications/progress'));
    const progress = client.notifications.find((n) => n.method === 'notifications/progress') as Json;
    expect(progress.params).toMatchObject({ progressToken: 'p1', progress: 1, message: 'running npm test' });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'gave-up', reason: 'client timeout' } });
    const retry = await client.call('isitdone_verify');
    expect(retry.result.structuredContent.done).toBe(false);
    expect(readFileSync(counter, 'utf8')).toBe('x'); // one run served both
    expect((await client.request('ping')).result).toEqual({});
    expect(client.lines.some((l) => l.includes('"gave-up"'))).toBe(false);
  }, 120_000);

  it('exits promptly and cleanly when stdin closes, killing a running check and leaving no receipt', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: SLOW }) } });
    client = new Client(repo.root);
    await client.initialize();
    client.send({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'isitdone_verify', arguments: {}, _meta: { progressToken: 1 } } });
    await client.until(() => client!.notifications.some((n) => n.method === 'notifications/progress'));
    const started = Date.now();
    expect(await client.close()).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000); // the check alone would take 20s
    expect(existsSync(join(repo.root, '.isitdone', 'receipt.json'))).toBe(false);
    expect(client.lines.some((l) => l.includes('"slow"'))).toBe(false);
  }, 60_000);

  it('honours the ISITDONE=1 nested guard: verify refuses, the read-only tools still answer', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: PASS }) } });
    client = new Client(repo.root, { env: { ISITDONE: '1' } });
    await client.initialize();
    const nested = await client.call('isitdone_verify');
    expect(nested.result.isError).toBe(true);
    expect(nested.result.content[0].text).toMatch(/refusing to run nested inside an isitdone check/);
    expect(existsSync(join(repo.root, '.isitdone'))).toBe(false);
    expect((await client.call('isitdone_detect')).result.isError).toBe(false);
    expect((await client.call('isitdone_receipt')).result.structuredContent.state).toBe('NONE');
  }, 60_000);

  it('answers a one-shot pipe: a request followed by EOF', () => {
    const r = spawnSync(process.execPath, [BUNDLE, 'mcp'], { cwd: process.cwd(), encoding: 'utf8', input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', windowsHide: true, timeout: 30_000 });
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout.trim()) as Json).result.tools).toHaveLength(3);
  });
});

describe('McpServer (in process)', () => {
  it('a client that declares roots but never answers falls back to the server cwd after the timeout', async () => {
    repo = tempRepo({ files: { 'package.json': nodePkg({ test: FAIL }) } });
    const sent: Json[] = [];
    const server = new McpServer({ send: (m) => sent.push(m), cwd: repo.root, rootsTimeoutMs: 50 });
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} } } }));
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'isitdone_detect' } }));
    expect(sent.map((m) => m.method ?? m.id)).toEqual([1, 'roots/list', 2]);
    expect(real(sent[2]?.result.structuredContent.root)).toBe(real(repo.root));
    // An error answer is a "no" as well, and is not asked again.
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }));
    const call = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'isitdone_detect' } }));
    const ask = sent.find((m, i) => i > 2 && m.method === 'roots/list') as Json;
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: ask.id, error: { code: -32601, message: 'nope' } }));
    await call;
    expect(real(sent[sent.length - 1]?.result.structuredContent.root)).toBe(real(repo.root));
    // After close() nothing is written any more.
    await server.close();
    const count = sent.length;
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }));
    expect(sent).toHaveLength(count);
  });

  it('firstFileRoot skips what is not a usable file:// directory', () => {
    repo = tempRepo({ files: { 'package.json': '{}' } });
    expect(firstFileRoot(undefined)).toBeNull();
    expect(firstFileRoot([{ uri: 'https://example.com' }, { uri: 42 }, null, { uri: pathToFileURL(join(repo.root, 'missing')).href }])).toBeNull();
    expect(real(firstFileRoot([{ uri: 'untitled:x' }, { uri: pathToFileURL(repo.root).href }]))).toBe(real(repo.root));
    // A root may be a file: its directory is what we can work in.
    expect(real(firstFileRoot([{ uri: pathToFileURL(join(repo.root, 'package.json')).href }]))).toBe(real(repo.root));
    // Percent-encoding, as VS Code sends it on Windows (file:///c%3A/...).
    expect(real(firstFileRoot([{ uri: pathToFileURL(repo.root).href.replace(/:/g, (m, i: number) => (i > 5 ? '%3A' : m)) }]))).toBe(real(repo.root));
  });

  it('toolsFor keeps a deterministic order and only adds fields a revision knows', () => {
    expect(toolsFor('2026-07-28').map((t) => t.name)).toEqual(toolsFor('2024-11-05').map((t) => t.name));
    expect(toolsFor('2024-11-05').every((t) => !('outputSchema' in t) && !('title' in t) && !('annotations' in t))).toBe(true);
    expect(JSON.stringify(toolsFor('2026-07-28'))).toBe(JSON.stringify(toolsFor('2026-07-28')));
  });
});

describe('MCP registry metadata', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as Json;
  const server = JSON.parse(readFileSync(resolve('server.json'), 'utf8')) as Json;

  it('server.json matches package.json (name, package, version) and the registry limits', () => {
    expect(server.name).toBe('io.github.raimondasl/isitdone');
    expect(pkg.mcpName).toBe(server.name); // the registry verifies npm ownership through this field
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: pkg.name, runtimeHint: 'npx', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', value: 'mcp' }] });
    // If this fails after a version bump: node scripts/sync-server-json.mjs
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it('scripts/sync-server-json.mjs --check agrees', () => {
    const r = spawnSync(process.execPath, [resolve('scripts/sync-server-json.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
