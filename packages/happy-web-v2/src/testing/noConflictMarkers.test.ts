import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/**
 * B-757: a rebase left `<<<<<<<` / `>>>>>>>` blocks in projects.css and every
 * gate stayed green — CSS parsers skip the garbage, so nothing failed. Any
 * conflict marker under src/ fails here instead.
 */
const MARKER = /^(<{7} |>{7} |={7}$)/m;
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(tsx?|css|md)$/.test(name)) yield path;
  }
}

it('no merge-conflict markers in web sources', () => {
  const root = new URL('..', import.meta.url).pathname;
  const hits = [...files(root)].filter((f) => MARKER.test(readFileSync(f, 'utf8')));
  expect(hits).toEqual([]);
});
