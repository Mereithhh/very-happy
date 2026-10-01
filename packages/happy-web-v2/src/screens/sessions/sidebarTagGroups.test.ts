import { describe, it, expect } from 'vitest';
import { groupRowsByTag } from './sidebarTagGroups';

type R = { key: string; tags?: string[] };
const row = (key: string, tags?: string[]): R => ({ key, tags });

const keysOf = (groups: Array<{ tag: string | null; rows: R[] }>) =>
  groups.map((g) => [g.tag, g.rows.map((r) => r.key)] as const);

describe('groupRowsByTag (B-091)', () => {
  it('groups by FIRST tag, preserving row order within a group', () => {
    const groups = groupRowsByTag([
      row('a', ['deploy']),
      row('b', ['infra']),
      row('c', ['deploy', 'infra']),
    ]);
    expect(keysOf(groups)).toEqual([
      ['deploy', ['a', 'c']],
      ['infra', ['b']],
    ]);
  });

  it('group identity is case-insensitive; first-seen casing labels it', () => {
    const groups = groupRowsByTag([row('a', ['Deploy']), row('b', ['deploy'])]);
    expect(keysOf(groups)).toEqual([['Deploy', ['a', 'b']]]);
  });

  it('untagged rows tail as the null group', () => {
    const groups = groupRowsByTag([row('t1'), row('a', ['deploy']), row('t2', [])]);
    expect(keysOf(groups)).toEqual([
      ['deploy', ['a']],
      [null, ['t1', 't2']],
    ]);
  });

  it('the priority group always renders first, other groups by first appearance', () => {
    const groups = groupRowsByTag([
      row('a', ['deploy']),
      row('b', ['Priority']),
      row('c', ['infra']),
      row('d'),
    ]);
    expect(keysOf(groups)).toEqual([
      ['P0', ['b']], // B-522: legacy `priority` is P0
      ['deploy', ['a']],
      ['infra', ['c']],
      [null, ['d']],
    ]);
  });

  it('B-522: priority groups P0 → P1 → P2 first, legacy and Pn spellings merged', () => {
    const groups = groupRowsByTag([
      row('a', ['P2']),
      row('b', ['deploy']),
      row('c', ['p1']),
      row('d', ['priority']),
      row('e', ['P0']),
    ]);
    expect(keysOf(groups)).toEqual([
      ['P0', ['d', 'e']],
      ['P1', ['c']],
      ['P2', ['a']],
      ['deploy', ['b']],
    ]);
  });

  it('all-untagged input yields a single null group; empty input yields none', () => {
    expect(keysOf(groupRowsByTag([row('a'), row('b')]))).toEqual([[null, ['a', 'b']]]);
    expect(groupRowsByTag([])).toEqual([]);
  });
});
