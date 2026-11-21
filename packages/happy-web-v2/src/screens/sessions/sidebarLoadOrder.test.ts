import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSidebarTree } from './sidebarTree';
import { sortGroupsByRecent, stabilizeGroupOrder, stabilizeRowOrder, type FrozenRowOrder } from './sidebarLoadOrder';
import { sortRowsByManualOrder } from './sidebarOrder';

type R = { key: string; ts: number; createdAt?: number; sessionId?: string };
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);
const row = (key: string, ts: number): R => ({ key, ts, sessionId: key });

describe('B-947 stabilizeRowOrder', () => {
  it('first pass = most recent first', () => {
    const { rows } = stabilizeRowOrder(null, [row('a', 1), row('b', 3), row('c', 2)]);
    expect(keys(rows)).toEqual(['b', 'c', 'a']);
  });

  it('activity after load does not reorder', () => {
    let st: FrozenRowOrder = stabilizeRowOrder(null, [row('a', 1), row('b', 3), row('c', 2)]).state;
    // background output on the bottom row, many times
    for (let t = 10; t < 20; t++) {
      const out: { state: FrozenRowOrder; rows: R[] } = stabilizeRowOrder(st, [row('a', t), row('b', 3), row('c', t + 1)]);
      st = out.state;
      expect(keys(out.rows)).toEqual(['b', 'c', 'a']);
    }
  });

  it('a new session goes on top; existing rows keep their places', () => {
    const first = stabilizeRowOrder(null, [row('a', 1), row('b', 3), row('c', 2)]);
    const next = stabilizeRowOrder(first.state, [row('a', 50), row('b', 3), row('c', 2), row('new', 100)]);
    expect(keys(next.rows)).toEqual(['new', 'b', 'c', 'a']);
  });

  it('a late-arriving old row slots in by its activity against the frozen values', () => {
    const first = stabilizeRowOrder(null, [row('a', 10), row('b', 30)]);
    const next = stabilizeRowOrder(first.state, [row('a', 99), row('b', 30), row('t:old', 20)]);
    expect(keys(next.rows)).toEqual(['b', 't:old', 'a']);
  });

  it('a row that disappears and comes back returns to its old place', () => {
    const first = stabilizeRowOrder(null, [row('a', 1), row('b', 3), row('c', 2)]);
    const gone = stabilizeRowOrder(first.state, [row('a', 1), row('b', 3)]);
    expect(keys(gone.rows)).toEqual(['b', 'a']);
    const back = stabilizeRowOrder(gone.state, [row('a', 1), row('b', 3), row('c', 999)]);
    expect(keys(back.rows)).toEqual(['b', 'c', 'a']);
  });

  it('re-sort (null state) orders by the latest activity', () => {
    const first = stabilizeRowOrder(null, [row('a', 1), row('b', 3)]);
    expect(keys(stabilizeRowOrder(first.state, [row('a', 9), row('b', 3)]).rows)).toEqual(['b', 'a']);
    expect(keys(stabilizeRowOrder(null, [row('a', 9), row('b', 3)]).rows)).toEqual(['a', 'b']);
  });

  it('is idempotent (re-running a memo changes nothing)', () => {
    const first = stabilizeRowOrder(null, [row('a', 1), row('b', 3)]);
    const again = stabilizeRowOrder(first.state, [row('a', 1), row('b', 3)]);
    expect(again.state).toBe(first.state);
  });
});

describe('B-947 stabilizeGroupOrder', () => {
  const g = (id: string, lastActivity: number) => ({ id, lastActivity });
  it('snapshot by recent activity, then fixed', () => {
    const first = stabilizeGroupOrder(null, sortGroupsByRecent([g('p1', 1), g('p2', 3), g('p3', 2)]), (x) => x.id);
    expect(first.groups.map((x) => x.id)).toEqual(['p2', 'p3', 'p1']);
    // p1 gets busy and the tree hands groups in a new order
    const next = stabilizeGroupOrder(first.state, [g('p1', 99), g('p2', 3), g('p3', 2)], (x) => x.id);
    expect(next.groups.map((x) => x.id)).toEqual(['p2', 'p3', 'p1']);
  });
  it('a new project goes on top', () => {
    const first = stabilizeGroupOrder(null, [g('p2', 3), g('p1', 1)], (x) => x.id);
    const next = stabilizeGroupOrder(first.state, [g('p1', 1), g('p2', 3), g('pNew', 0)], (x) => x.id);
    expect(next.groups.map((x) => x.id)).toEqual(['pNew', 'p2', 'p1']);
  });
});

describe('B-947 tree: frozen rows + frozen groups', () => {
  const project = (id: string, createdAt: number) => ({ id, name: id, createdAt, updatedAt: createdAt, folders: [], teamIds: [] }) as never;
  const member = (projectId: string, sessionId: string) => ({ projectId, sessionId }) as never;
  const projects = [project('A', 1), project('B', 1), project('C', 1)];
  const members = [member('A', 'a1'), member('A', 'a2'), member('B', 'b1'), member('C', 'c1')];
  const build = (rows: R[]) => buildSidebarTree({ rows, projects, members, teams: [], needsYou: () => false });

  it('background output in the bottom project moves neither the project nor its rows', () => {
    const r0 = stabilizeRowOrder(null, [row('a1', 30), row('a2', 25), row('b1', 20), row('c1', 10)]);
    const t0 = build(r0.rows);
    const g0 = stabilizeGroupOrder(null, sortGroupsByRecent(t0.projects), (x) => x.id);
    expect(g0.groups.map((x) => x.id)).toEqual(['project:A', 'project:B', 'project:C']);
    // c1 and a2 print continuously
    const r1 = stabilizeRowOrder(r0.state, [row('a1', 30), row('a2', 500), row('b1', 20), row('c1', 1000)]);
    const t1 = build(r1.rows);
    const g1 = stabilizeGroupOrder(g0.state, t1.projects, (x) => x.id);
    expect(g1.groups.map((x) => x.id)).toEqual(['project:A', 'project:B', 'project:C']);
    expect(keys(g1.groups[0].rows)).toEqual(['a1', 'a2']);
  });

  it('a new session in the bottom project tops that project only', () => {
    const r0 = stabilizeRowOrder(null, [row('a1', 30), row('b1', 20), row('c1', 10)]);
    const g0 = stabilizeGroupOrder(null, sortGroupsByRecent(build(r0.rows).projects), (x) => x.id);
    const withNew = [...members, member('C', 'c2')];
    const r1 = stabilizeRowOrder(r0.state, [row('a1', 30), row('b1', 20), row('c1', 10), row('c2', 999)]);
    const t1 = buildSidebarTree({ rows: r1.rows, projects, members: withNew, teams: [], needsYou: () => false });
    const g1 = stabilizeGroupOrder(g0.state, t1.projects, (x) => x.id);
    expect(g1.groups.map((x) => x.id)).toEqual(['project:A', 'project:B', 'project:C']);
    expect(keys(g1.groups[2].rows)).toEqual(['c2', 'c1']);
  });
});

describe('B-947 manual order is untouched', () => {
  it('sortRowsByManualOrder ignores activity entirely', () => {
    const entries = [{ key: 'a', order: 'a0' }, { key: 'b', order: 'a1' }];
    const rows = [{ key: 'b', ts: 999, createdAt: 1 }, { key: 'a', ts: 1, createdAt: 1 }];
    expect(keys(sortRowsByManualOrder(rows, entries))).toEqual(['a', 'b']);
  });

  it('Sidebar wires the frozen order only into the non-manual fallback, and the re-sort menu item', () => {
    const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
    const manual = src.indexOf('priorityFirst(sortRowsByManualOrder(rows, orderSetting!))');
    const frozen = src.indexOf('stabilizeRowOrder(rowOrderRef.current, rows)');
    expect(manual).toBeGreaterThan(0);
    expect(frozen).toBeGreaterThan(manual); // manual returns before the frozen fallback
    expect(src).toContain("key: 'resort-recent'");
    expect(src).toContain('stabilizeGroupOrder(prev, prev ? built.projects : sortGroupsByRecent(built.projects)');
  });
});
