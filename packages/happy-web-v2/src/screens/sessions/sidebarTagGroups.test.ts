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
      ['Priority', ['b']],
      ['deploy', ['a']],
      ['infra', ['c']],
      [null, ['d']],
    ]);
  });

  it('all-untagged input yields a single null group; empty input yields none', () => {
    expect(keysOf(groupRowsByTag([row('a'), row('b')]))).toEqual([[null, ['a', 'b']]]);
    expect(groupRowsByTag([])).toEqual([]);
  });
});
