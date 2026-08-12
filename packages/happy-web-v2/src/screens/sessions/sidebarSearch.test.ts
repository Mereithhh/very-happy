import { describe, it, expect } from 'vitest';
import { parseSidebarQuery, rowMatchesSidebarQuery, sidebarQueryIsEmpty } from './sidebarSearch';

const row = (title: string, subtitle: string, tags?: string[]) => ({ title, subtitle, tags });

describe('parseSidebarQuery', () => {
  it('plain text stays text', () => {
    expect(parseSidebarQuery('hello world')).toEqual({
      text: 'hello world',
      tags: [],
      requireAnyTag: false,
    });
  });

  it('#tag tokens become lowercased tag terms', () => {
    expect(parseSidebarQuery('#Deploy #infra')).toEqual({
      text: '',
      tags: ['deploy', 'infra'],
      requireAnyTag: false,
    });
  });

  it('mixed text and tags split correctly', () => {
    expect(parseSidebarQuery('api #prod server')).toEqual({
      text: 'api server',
      tags: ['prod'],
      requireAnyTag: false,
    });
  });

  it('bare # requires any tag', () => {
    expect(parseSidebarQuery('#')).toEqual({ text: '', tags: [], requireAnyTag: true });
  });

  it('empty/whitespace query is empty', () => {
    expect(sidebarQueryIsEmpty(parseSidebarQuery('   '))).toBe(true);
    expect(sidebarQueryIsEmpty(parseSidebarQuery('#x'))).toBe(false);
    expect(sidebarQueryIsEmpty(parseSidebarQuery('#'))).toBe(false);
  });
});

describe('rowMatchesSidebarQuery', () => {
  it('text matches title or subtitle, case-insensitive substring', () => {
    const q = parseSidebarQuery('DEPLOY');
    expect(rowMatchesSidebarQuery(row('deploy pipeline', 'x'), q)).toBe(true);
    expect(rowMatchesSidebarQuery(row('x', 'my-deploy-box'), q)).toBe(true);
    expect(rowMatchesSidebarQuery(row('x', 'y'), q)).toBe(false);
  });

  it('#tag matches by exact or prefix, case-insensitive', () => {
    const q = parseSidebarQuery('#dep');
    expect(rowMatchesSidebarQuery(row('x', 'y', ['Deploy']), q)).toBe(true);
    expect(rowMatchesSidebarQuery(row('x', 'y', ['api']), q)).toBe(false);
    expect(rowMatchesSidebarQuery(row('x', 'y'), q)).toBe(false);
  });

  it('multiple tag terms AND together', () => {
    const q = parseSidebarQuery('#a #b');
    expect(rowMatchesSidebarQuery(row('x', 'y', ['a', 'b', 'c']), q)).toBe(true);
    expect(rowMatchesSidebarQuery(row('x', 'y', ['a']), q)).toBe(false);
  });

  it('text and tags both constrain', () => {
    const q = parseSidebarQuery('api #prod');
    expect(rowMatchesSidebarQuery(row('api server', 'y', ['prod']), q)).toBe(true);
    expect(rowMatchesSidebarQuery(row('api server', 'y', ['dev']), q)).toBe(false);
    expect(rowMatchesSidebarQuery(row('web server', 'y', ['prod']), q)).toBe(false);
  });

  it('bare # keeps only rows that have at least one tag', () => {
    const q = parseSidebarQuery('#');
    expect(rowMatchesSidebarQuery(row('x', 'y', ['a']), q)).toBe(true);
    expect(rowMatchesSidebarQuery(row('x', 'y', []), q)).toBe(false);
    expect(rowMatchesSidebarQuery(row('x', 'y'), q)).toBe(false);
  });
});
