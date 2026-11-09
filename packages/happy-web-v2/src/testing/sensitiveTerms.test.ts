import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-764: the repository is public, yet fixtures, dev harnesses, comments and a
 * placeholder carried the Owner's real team names, a team goal verbatim and
 * real session / worktree ids. This guard fails when any listed term shows up
 * again in any tracked text file (B-905 widened it from package sources, specs
 * and docs to the whole tree: ops config, scripts, e2e harnesses, root docs). Terms are stored only as SHA-256 of
 * their lowercase form, so the list itself never spells them out; use neutral
 * examples (「订单看板」, `atlas-pay`, `sess-lead-a`, `wt-0001`) instead.
 * To add a term: `printf %s '<term in lowercase>' | sha256sum`. A term that
 * mixes ASCII and CJK (B-768) is hashed without its separators
 * (`Atlas Pay 看板` → `atlaspay看板`), so spacing, hyphen and case variants all hit.
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
  'bfdc2a9c2b7345ed8e5264aa47354df0dc359974910907ede8ad8d33e92bb276',
  // B-905: organisation names and domains, internal system and host names,
  // cloud account and DNS zone ids.
  'c12d355660984790ff3e5e3fe877b51e9f4f5ac02fe9895d72c043839ac06a4b',
  '4c58b0c300aad7e18979910863e4bcdda5c4783b9430300a327ea1918873cda4',
  '37268bac06c26e759c8658d038e569af58c95e81815da5c377853fc7c98de7f6',
  '590a7c9abe8d8f3bdc4576b91aed45be63557db438960deddbc9213e9a4e16d8',
  '2f8b2d10953eeadaeea8169cdde57c5986abcca2784fd4feb21493937ff48abd',
  '4922a523992c13956a6f8594e1904e19dc10469b9e8f5df2350b4fa175d81f9d',
  'bb58f059967b69b18f1a965635a7108ad72d2affe7330a6965e6a10c9a043791',
  '351ade2f72aed0d0172b7e7ac34d25b66f36d4087c720ab6bb0987e5206a22b3',
  '82832c4f0192b5746966c79ea7479e3ceb10382871a39751833adf0e32de204e',
  'de17cc0a4a0eab1775b3f7a1010489ddbff3e6cc367fccbf0bfcabded127e5a3',
  '6a61d722665c91493b6ec3bdb1c46fa24e5ee378fb4ee7afecd4d47a3ca2ac81',
  '5a9dcf6762a14fa6e769b5b54298e3ed7c7e152b48c920bc84cfa134682e558b',
  'f7d46d72dea46b5650c1ce579fe2b8662c0003f380df7b637f54e0dfb4849c8b',
  '97b5dfaf9ba8af1a9e5a69894c407fa2ec00427a48fc3552d16780a0b90a9fcf',
  'a3c1d7a1154c6f5c0bdd0174b3615e229f40448ebfeda321353bd1e7261a5ee8',
  '1454fdfaba0386b1d5585d97014f0bdac530ebd03bb58c182e5e5d4a81caf553',
  '27bdabef11ad43319177660626c4ee380aab396f2408c60d5db3ff3fc5c63e53',
  '62ea4337f33ea47189614d7ec15d0cc32bc370f3d7ccbc651433064e26cb379e',
  'bb64e3f7e06b7f652ecf84f9f2230f6efeeff2c51764126aafe97d465c64de26',
  '04439f68a0fbafe0772ad48d7684ff96d79900a757457bcfb53bab305339543f',
  '3dc07fdf3b52d1317659883ca75ef9fc64c312b536245696d2313a5d55732fe3',
  'bb50b09bb31226899944b55551618599d7075978f62a969554c5a58e05d85855',
  'd0dd96141cb7ebccd340a687664620cee3aae6bfabc49438a084423d76ee7c80',
]);
/**
 * B-905: people's names, hashed with their words joined (`Ada Lovelace` →
 * `adalovelace`) in both orders (given + family and family + given; B-905b
 * added the second). A run of 2 or 3 words separated by space, `_` or `-` is
 * checked joined, and so is every substring of a letter run (`adalovelace`,
 * `byAdaLovelace`), so case, spacing, hyphen and no-separator variants all hit.
 * To add a name, add the hash of each order.
 */
const NAME_TERMS = new Set([
  '427fe6007ab776480fe71f080c359206fe7d76045c83035ee24d835c4b71bff2',
  '3f7b38a9e903ab07f2c6463bafbe529af3a73a5ef11f02b8b7b60dcac1b0e785',
  '5de635b77ae5259c288d4589099598f090645328daaa21396dd2446aa75b415c',
  '9848f8d0c07253e6870deb5e7468d26228567e440f197f911eef59f4fb296995',
  '713c01329caf6d9bba1fae48d32300229ff391cf25a275f15c6d57e8f1f0f22d',
  '37647699220399701aa30f9e2c80a85fb5a2213168272a2e952d078f520f9d06',
  '3b1e4bf1a81c9810657ab7a804d4933485353c52a7d262c04de6e5e76bc6769c',
  '3d6f66fbb345b8a281e1d68445996ae7d0ac51eb115b589f7f65c52a485403e5',
  '6c45faf596931eeec3102b56e206bc40ad533e744a1d58464129866fb9870390',
  '48696fbbf5e1d701ff4d295eb36f52454557c6f1567e88a3d3f5fdbb9d760b1f',
  '2f1a0dd023c22732df4df53785cbb1c28ae3a0729ae0c74a6743f967a78ab2f8',
  '158c703de55fc66e1e87e50f2259da0ac976bffafddcb65912d186fbf51e5b73',
  'f8107eae4f41230218b7af32867a0e25c3833e183962727498c69c62db6902c5',
  '1a247082310cfb8aa2e06a73fb814d12a47e73885a37c442d450ec3db1b7fb90',
  '2e762af0b28cafc73e1c8e0ccba59a8ceb1433f2b5adfa6fce5d4bd5671a2661',
  '0ff7d4ce8f28b77972730c1f38355e594f8164251ca5f08935383c746f6a6fe8',
  '74d74c4a8ad879e62943f1b0ae4c51a18bbc0a9ba2e8e087f26ff22e4b5ed69a',
  '1fb0c759100166d60fa4af3661c5ee93920505ae0da6ab469bec9dfe6f7e9cbc',
  '71b48da96280e44e6d50b766fc1f5fe1685a471e06607d144498e0b0b5f0e36b',
  'f9255ef40e9e023753afc5efd5729d1e4decee20b93c877e41a8478569d19d35',
  '768942bfcc18ff1e874d37dd008e5683fb86a211b6d5a46c75b56fd57401f1a5',
  // B-905b: the same names in the other order.
  '33899e790b25a9af0abfb30216416ece97e9e29b53855e2d9a8cf8d93f3a02ea',
  'abc2b0bf1e7e2e37224130c27bada5151cfd6fd71ce74033de0c810d3030aaf8',
  'f3f6bbc64c09f071550ba399b2b1d7ef9309010a0f7de1b3dd7a511b3f7d0935',
  '7d1dd7581daf3d8e978ca582f8addd82723838653893a883c0185aaf733e5da9',
  '3271cc978c1e2f0d0c8f5377db352880085a71f5d6248065bde263abac8cf7c5',
  '1a66e41e2c906d972e1d7143f42c5881c1e5ff73288f9e1bb6052f3a0bc9cfc6',
  '3dda85ebfb0fd5939d88f4e7419c09e269800655f1232416d5cd11afbf72b77e',
  '98709b4958f28108685941083333330b99f816e4e5c813ee33a8403149722afd',
  '15e16a057e81c0433c88039b14c2c28e633faae12c918e0afa4fc976cab27e62',
  '330632a0d504619f8251972db568fe1f9c80c85219039bac2004b6c0848dc727',
  'cdcb1590dea3b35f03d47d23a8d723dcaff77e7136a787948043c0168a496257',
  'cea57532dbbccf0511762af9096afb13e4426ad944177f4b604f32a3aa8dff28',
  'ce99d7a74e6a0aba0493a1f7f918f7e3e54eeaeafeb038dfab169808a81b8689',
  'e15429e2a4fc71dba0b55a2cb770a1f29b9ab01c7786aca2867803324d4af298',
  '27c4f3b54a61a3b527701a1fae88830c45b413f95126d22f1bc4be22167dc5c0',
  '406fefa6adcf29a22fa462c630a731fdf6e11e152a2e82ccb9ec8ce3fb79b91e',
  '6d63a38450cff32e004e29ed72700c40a12e0a66e69736e60c5d5f343590be46',
  '78d9bce196d81200cf314f19a2cb41a784ecd1c88ec2fadcf9d03d2e3279f129',
  '2ca99a9fd49c10370c0710eb71b78beffc297121fa630e4f2176b3b8cba2cba0',
  '87b27d5a4c3728ba6a10f45180c0bb91525508c36c569231cf4dbc2265870d6c',
  '43af989aae255642d4fc8aff3f32b04722547191890be7fdd601bbdcfeb00160',
]);
// Lengths (in code points) of the hashed terms, per script.
const ASCII_LENGTHS = [6, 7, 8, 9, 12, 13, 17, 20, 21];
const CJK_LENGTHS = [2, 3, 6, 7];
const MIXED_LENGTHS = [11];
/** Lengths of the hashed names (letters only). */
const NAME_LENGTHS = [6, 7, 8, 9, 10, 11, 12, 13];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Windows of each length starting at an ASCII word start (a word is
 * `[a-z0-9-]+`; each hyphen-separated part starts one too) and at every CJK
 * character; one that hashes into `terms` is a hit. Mixed windows start at an
 * ASCII word start inside a run of ASCII words that ends in CJK on the same
 * line, with spaces, `_` and `-` dropped.
 */
function findTerms(text: string, terms: Set<string>, asciiLengths: number[], cjkLengths: number[], mixedLengths: number[] = [], seen = new Map<string, boolean>()): string[] {
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
  if (mixedLengths.length) {
    for (const [run] of lower.matchAll(/[a-z0-9][a-z0-9 \t\u3000_-]*\p{Script=Han}+/gu)) {
      for (const { index } of run.matchAll(/(?<![a-z0-9])[a-z0-9]/g)) {
        const chars = Array.from(run.slice(index).replace(/[ \t\u3000_-]+/g, ''));
        for (const n of mixedLengths) if (n <= chars.length) check(chars.slice(0, n).join(''));
      }
    }
  }
  return hits;
}

/**
 * Runs of 2–3 ASCII words separated by space, `_` or `-`, joined, and every
 * substring of each letter run with a length in `lengths` (names written with
 * no separator); one that hashes into `terms` is a hit.
 */
function findNames(text: string, terms: Set<string>, lengths: number[], seen = new Map<string, boolean>()): string[] {
  const hits: string[] = [];
  const check = (joined: string) => {
    let hit = seen.get(joined);
    if (hit === undefined) seen.set(joined, hit = terms.has(sha256(joined)));
    if (hit) hits.push(joined);
  };
  const lower = text.toLowerCase();
  for (const [run] of lower.matchAll(/[a-z]+(?:[ \t_-]+[a-z]+)+/g)) {
    const words = run.split(/[ \t_-]+/);
    for (let i = 0; i + 1 < words.length; i++) {
      for (const n of [2, 3]) if (i + n <= words.length) check(words.slice(i, i + n).join(''));
    }
  }
  for (const [run] of lower.matchAll(/[a-z]+/g)) {
    for (let i = 0; i < run.length; i++) {
      for (const n of lengths) if (i + n <= run.length) check(run.slice(i, i + n));
    }
  }
  return hits;
}

const repo = new URL('../../../../', import.meta.url).pathname;
const TEXT = /\.(tsx?|mts|mjs|cjs|js|jsx|css|md|mdx|json|jsonl|html|ya?ml|txt|sh|toml|conf|env|example|tsv|csv|svg|plist|service|sql|prisma|rs)$|(^|\/)(Caddyfile[^/]*|Dockerfile[^/]*|Makefile|\.gitignore)$/;
/** Every tracked text file; lockfiles are generated and skipped. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  return out.split('\0').filter((f) => f && TEXT.test(f) && !/(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.lock)$/.test(f));
}

describe('sensitive terms (B-764, B-905)', () => {
  it('the matcher finds hashed ASCII, prefixed and CJK terms', () => {
    const terms = new Set(['atlas-pay', 'sess7', '订单看板'].map(sha256));
    expect(findTerms('team "Atlas-Pay-ops" / my-atlas-pay / sess7abc / 「订单看板」', terms, [5, 9], [4])).toEqual(['atlas-pay', 'atlas-pay', 'sess7', '订单看板']);
    expect(findTerms('xatlas-pay sess-7 订单看', terms, [5, 9], [4])).toEqual([]);
  });

  it('the matcher finds a mixed ASCII + CJK term in any spacing, hyphen or case variant', () => {
    const terms = new Set([sha256('atlaspay看板')]);
    const find = (text: string) => findTerms(text, terms, [], [], [10]);
    expect(find('「Atlas Pay 看板」 / atlas-pay-看板 / ATLASPAY看板 / my atlaspay_看板组')).toEqual(['atlaspay看板', 'atlaspay看板', 'atlaspay看板', 'atlaspay看板']);
    expect(find('xatlas pay 看板 / atlas pay\n看板 / atlas pay 看 / atlas, pay 看板')).toEqual([]);
  });

  it('the name matcher finds a joined 2–3 word name in any case, spacing or hyphen variant', () => {
    const terms = new Set(['adalovelace', 'grace-hopper-x'.replace(/-/g, '')].map(sha256));
    expect(findNames('Ada LOVELACE / ada-lovelace / ada_lovelace / reported by Grace Hopper X', terms, [])).toEqual(['adalovelace', 'adalovelace', 'adalovelace', 'gracehopperx']);
    expect(findNames('ada, lovelace / ada\nlovelace / adam lovelace', terms, [])).toEqual([]);
  });

  it('the name matcher finds a name written with no separator, in either order and any case (B-905b)', () => {
    const terms = new Set(['adalovelace', 'lovelaceada'].map(sha256));
    const find = (text: string) => findNames(text, terms, [11]);
    expect(find('HAPPY_SPAWNED_BY=adalovelace')).toEqual(['adalovelace']);
    expect(find('tmp/lovelaceada-ios/repro.cjs')).toEqual(['lovelaceada']);
    expect(find('AdaLovelace / LOVELACEADA / byadalovelacex')).toEqual(['adalovelace', 'lovelaceada', 'adalovelace']);
    expect(find('ada1lovelace / adalovelac / lovelace.ada')).toEqual([]);
  });

  it('no listed term appears in any tracked text file', () => {
    const seen = new Map<string, boolean>();
    const nameSeen = new Map<string, boolean>();
    const hits: string[] = [];
    for (const file of trackedFiles()) {
      const path = join(repo, file);
      let text: string;
      try {
        if (statSync(path).size > 4 << 20) continue;
        text = readFileSync(path, 'utf8');
      } catch { continue; } // deleted in the working tree
      if (findTerms(text, TERMS, ASCII_LENGTHS, CJK_LENGTHS, MIXED_LENGTHS, seen).length || findNames(text, NAME_TERMS, NAME_LENGTHS, nameSeen).length) hits.push(file);
    }
    expect(hits).toEqual([]);
  }, 120_000);
});
