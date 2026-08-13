import { describe, it, expect } from 'vitest';
import { closedTerminalsOf, buildClosedTerminalRows } from './closedTerminals';

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

  it('falls back to the machine name when the record has no title', () => {
    const rows = buildClosedTerminalRows(
      [machine('m1', [{ id: 'a', closedAt: 1 }], { name: 'mac-office' })],
      new Set(),
    );
    expect(rows[0].title).toBe('mac-office');
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
