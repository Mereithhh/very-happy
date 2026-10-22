import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-764: the repository is public, yet fixtures, dev harnesses, comments and a
 * placeholder carried the Owner's real team names, a team goal verbatim and
 * real session / worktree ids. This guard fails when any listed term shows up
 * again in package sources, specs or docs. Terms are stored only as SHA-256 of
 * their lowercase form, so the list itself never spells them out; use neutral
 * examples (「订单看板」, `atlas-pay`, `sess-lead-a`, `wt-0001`) instead.
 * To add a term: `printf %s '<term in lowercase>' | sha256sum`.
 */
const TERMS = new Set([
  '7cf393b53fce62e79de82e56eb71139573f53c285a3189b0ebe96e816629a756',
  '0ce93c700743ee29a998abacb491916ddb1d9521d164fa0515869a8483957578',
  '2aa3f1c4d55080f1b96a4c739fd2ef63ec1d406ba4375e139147805a5bbe8d01',
  'd5d8cb8e8a430f3620914c0ff68708a2cabbf073faa03831d809431e25d37632',
  '23ace3042eb9c62ff358337837d5799d3832c872b821e2b5541b9b5b827af73b',
  '32c2fd7428ae3e719487ac1f4549d295b149ba64d8f92b2a002f21bd99537aa7',
  '40478ea553a14e0c5c3d21ceae0b9d0b7589204b5e648315d1e51e2ab2fa2b0f',
  '8ba493f2e2ece9dcab6f58c85d64cfd5b768d3ced2eccb89915a3622cfffd333',
  '79383dd3e0fe8d495240818ea48154cc2baa34c2d103578fe038650753db05fd',
  '16d3fc1f8837ed2c29a81e7c14fc8e243a52d2578492e3d5ea8d21cc55e44626',
]);
// Lengths (in code points) of the hashed terms, per script.
const ASCII_LENGTHS = [7, 8, 9, 13];
const CJK_LENGTHS = [2, 6, 7];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Windows of each length starting at an ASCII word start (a word is
 * `[a-z0-9-]+`; each hyphen-separated part starts one too) and at every CJK
 * character; one that hashes into `terms` is a hit.
 */
function findTerms(text: string, terms: Set<string>, asciiLengths: number[], cjkLengths: number[], seen = new Map<string, boolean>()): string[] {
  const hits: string[] = [];
  const check = (window: string) => {
    let hit = seen.get(window);
    if (hit === undefined) seen.set(window, hit = terms.has(sha256(window)));
    if (hit) hits.push(window);
  };
  const lower = text.toLowerCase();
  for (const [word] of lower.matchAll(/[a-z0-9][a-z0-9-]*/g)) {
    for (let i = 0; i < word.length; i = word.indexOf('-', i) + 1 || word.length) {
      if (word[i] === '-') continue;
      for (const n of asciiLengths) if (i + n <= word.length) check(word.slice(i, i + n));
    }
  }
  for (const [run] of lower.matchAll(/\p{Script=Han}+/gu)) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length; i++) {
      for (const n of cjkLengths) if (i + n <= chars.length) check(chars.slice(i, i + n).join(''));
    }
  }
  return hits;
}

const repo = new URL('../../../../', import.meta.url).pathname;
const ROOTS = ['packages/happy-web-v2/src', 'packages/happy-cli/src', 'packages/happy-server/sources', 'packages/happy-wire/src', 'specs', 'docs'];
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(tsx?|mts|mjs|cjs|js|css|md|json|html|ya?ml|txt)$/.test(name)) yield path;
  }
}

describe('sensitive terms (B-764)', () => {
  it('the matcher finds hashed ASCII, prefixed and CJK terms', () => {
    const terms = new Set(['atlas-pay', 'sess7', '订单看板'].map(sha256));
    expect(findTerms('team "Atlas-Pay-ops" / my-atlas-pay / sess7abc / 「订单看板」', terms, [5, 9], [4])).toEqual(['atlas-pay', 'atlas-pay', 'sess7', '订单看板']);
    expect(findTerms('xatlas-pay sess-7 订单看', terms, [5, 9], [4])).toEqual([]);
  });

  it('no listed term appears in package sources, specs or docs', () => {
    const seen = new Map<string, boolean>();
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(join(repo, root))) {
        if (findTerms(readFileSync(file, 'utf8'), TERMS, ASCII_LENGTHS, CJK_LENGTHS, seen).length) hits.push(file.slice(repo.length));
      }
    }
    expect(hits).toEqual([]);
  }, 60_000);
});
