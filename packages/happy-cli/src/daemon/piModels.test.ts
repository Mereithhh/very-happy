import { describe, expect, it } from 'vitest';
import { detectPiModels, parsePiListModels } from './piModels';

const SAMPLE = [
  'provider  model       context  max-out  thinking  images',
  'fakehub   fake-large  200K     16.4K    yes       no    ',
  'fakehub   fake-small  128K     16.4K    no        no    ',
  'fakehub   fake-small  128K     16.4K    no        no    ',
  'bad;host  x;y         1K       1K       no        no    ',
  '',
].join('\n');

describe('parsePiListModels (B-978)', () => {
  it('reads provider/id codes, thinking support, and drops duplicates and unsafe ids', () => {
    expect(parsePiListModels(SAMPLE)).toEqual([
      { code: 'fakehub/fake-large', value: 'fakehub/fake-large', thinking: true },
      { code: 'fakehub/fake-small', value: 'fakehub/fake-small', thinking: false },
    ]);
  });

  it('returns nothing for the no-models warning or empty output', () => {
    expect(parsePiListModels('Warning: No models available. Use /login to log into a provider.\n')).toEqual([]);
    expect(parsePiListModels('')).toEqual([]);
  });
});

describe('detectPiModels (B-978)', () => {
  it('wraps the parsed table with the check time and daemon pid', async () => {
    const table = await detectPiModels(async () => SAMPLE, 123, 7);
    expect(table?.checkedAt).toBe(123);
    expect(table?.daemonPid).toBe(7);
    expect(table?.models.map((m) => m.code)).toEqual(['fakehub/fake-large', 'fakehub/fake-small']);
  });

  it('is null when pi is missing or fails, so the Web keeps showing only default', async () => {
    expect(await detectPiModels(async () => { throw new Error('ENOENT'); })).toBeNull();
  });
});
