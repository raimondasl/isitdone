import { describe, expect, it } from 'vitest';
import { classifyCommand, TurnTracker, type ClaimRecord } from '../src/turns.js';

describe('classifyCommand', () => {
  it('recognises test and check commands, including bare isitdone but not its other subcommands', () => {
    expect(classifyCommand('npm test')).toBe('test');
    expect(classifyCommand('npx vitest run test/a.test.ts')).toBe('test');
    expect(classifyCommand('go test ./...')).toBe('test');
    expect(classifyCommand('npx isitdone')).toBe('test');
    expect(classifyCommand('npx isitdone --json')).toBe('test');
    expect(classifyCommand('isitdone run --all')).toBe('test');
    for (const sub of ['doctor', 'init --agent codex', 'history', 'hook --host claude', 'update', 'receipt --md', 'detect']) expect(classifyCommand(`npx isitdone ${sub}`)).toBeNull();
    expect(classifyCommand('npx tsc --noEmit')).toBe('check');
    expect(classifyCommand('npm run lint')).toBe('check');
  });

  it('counts real shell writes as edits but not redirections or the word patch inside quotes and paths', () => {
    expect(classifyCommand('sed -i "s/a/b/" src/x.ts')).toBe('edit');
    expect(classifyCommand('echo "x" > out.txt')).toBe('edit');
    expect(classifyCommand('cat >> notes.md <<EOF')).toBe('edit');
    expect(classifyCommand('mv a.ts b.ts')).toBe('edit');
    expect(classifyCommand('patch -p1 < fix.diff')).toBe('edit');
    expect(classifyCommand('git apply fix.diff')).toBe('edit');
    expect(classifyCommand('grep -rn "=>" src')).toBeNull();
    expect(classifyCommand("rg '->' src/")).toBeNull();
    expect(classifyCommand('grep -n "a > b" x.md')).toBeNull();
    expect(classifyCommand('python -c "print(1>0)"')).toBeNull();
    expect(classifyCommand('ls >/dev/null')).toBeNull();
    expect(classifyCommand('cat src/patch.ts')).toBeNull();
    expect(classifyCommand('git log -- src/patch.ts')).toBeNull();
    expect(classifyCommand('ls 2>&1')).toBeNull();
  });
});

describe('TurnTracker', () => {
  const track = () => {
    const out: ClaimRecord[] = [];
    const t = new TurnTracker({ project: () => 'p', session: 's', agent: 'codex', sinceMs: 0 }, out, { editTurns: 0 });
    return { t, out };
  };

  it('follows a command whose outcome arrives under another id, and forgets a command that never ran', () => {
    const { t, out } = track();
    t.edit(1);
    t.command('c1', 'npm test', 2);
    t.rekey('c1', 'session:7'); // still running after the yield window
    t.rekey('session:7', 'w1'); // polled by write_stdin
    expect(t.isPending('c1')).toBe(true);
    t.resolve('w1', false, 3);
    t.text('Done, tests pass.', 4);
    t.finalize();
    expect(out.map((c) => c.verdict)).toEqual(['FAILED']);

    const second = track();
    second.t.edit(1);
    second.t.command('c2', 'npm test', 2);
    second.t.forget('c2');
    second.t.text('Done, tests pass.', 4);
    second.t.finalize();
    expect(second.out.map((c) => c.verdict)).toEqual(['NEVER_RAN']);
  });
});
