// B-955: behaviour of check-changelog-versions.mjs on throwaway git repos.
// Each case builds a tiny history (changelog + tags + CLI commits) and runs the
// real script in it, so the rules are pinned end to end, not just helpers.
// CHECK_CHANGELOG_SCRIPT can point at another copy (e.g. the pre-B-955 one)
// to show both judge every case the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
    process.env.CHECK_CHANGELOG_SCRIPT ?? join(dirname(fileURLToPath(import.meta.url)), 'check-changelog-versions.mjs'),
);
const CHANGELOG = 'packages/happy-web-v2/src/app/changelogRelease.ts';

function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'b955-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    const entries = [];
    let n = 0;
    const write = (path, text) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
    };
    const changelog = () =>
        `export const CHANGELOG_RELEASES = [\n${entries
            .map((e) => `    {\n        id: '${e.id}',\n${e.cliVersion ? `        cliVersion: '${e.cliVersion}',\n` : ''}    },\n`)
            .join('')}];\n`;
    const r = {
        dir,
        /** Commit new entries; `cli: true` also touches CLI code in the same commit. */
        add(list, { cli = false } = {}) {
            entries.unshift(...list);
            write(CHANGELOG, changelog());
            if (cli) write('packages/happy-cli/src/x.ts', `export const x = ${++n};\n`);
            git('add', '-A');
            git('commit', '-q', '-m', `c${++n}`);
            return r;
        },
        cli() {
            write('packages/happy-cli/src/x.ts', `export const x = ${++n};\n`);
            git('add', '-A');
            git('commit', '-q', '-m', `cli${n}`);
            return r;
        },
        tag(version) {
            git('tag', `v${version}`);
            return r;
        },
        run() {
            const trace = join(dir, '..', `${dir.split('/').at(-1)}.trace`);
            const res = spawnSync(process.execPath, [SCRIPT], {
                cwd: dir,
                encoding: 'utf8',
                env: { ...process.env, GIT_TRACE: trace },
            });
            let pickaxe = 0;
            try {
                pickaxe = readFileSync(trace, 'utf8').split('\n').filter((l) => /built-in: git log .* -S /.test(l)).length;
                rmSync(trace);
            } catch {}
            rmSync(dir, { recursive: true, force: true });
            return { code: res.status, out: res.stdout, err: res.stderr, pickaxe };
        },
    };
    return r;
}

/** Shared base: two released versions, entries shipped with their own code. */
function released() {
    return repo()
        .add([{ id: 'a-first', cliVersion: '0.2.1' }], { cli: true })
        .tag('0.2.1')
        .add([{ id: 'b-second', cliVersion: '0.2.2' }], { cli: true })
        .tag('0.2.2');
}

test('released entries inside their own tag pass', () => {
    const r = released().run();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no cliVersion runs ahead of the next release \(0\.2\.3\)/);
});

test('an entry for the very next patch passes', () => {
    const r = released().add([{ id: 'c-next', cliVersion: '0.2.3' }], { cli: true }).run();
    assert.equal(r.code, 0, r.err);
});

test('an invented cliVersion far ahead fails', () => {
    const r = released().add([{ id: 'c-invented', cliVersion: '0.2.121' }], { cli: true }).run();
    assert.equal(r.code, 1);
    assert.match(r.err, /0\.2\.121: ahead of the next patch — the next release is 0\.2\.3/);
});

test('skipping one number (next patch + 1) fails', () => {
    const r = released().add([{ id: 'c-skip', cliVersion: '0.2.4' }], { cli: true }).run();
    assert.equal(r.code, 1);
    assert.match(r.err, /0\.2\.4: ahead of the next patch/);
});

test('web-only entries without cliVersion are not checked', () => {
    const r = released().add([{ id: 'c-web-only' }]).add([{ id: 'd-web-only' }], { cli: true }).run();
    assert.equal(r.code, 0, r.err);
});

test('an entry naming a tag that does not contain its code fails (B-347)', () => {
    const r = released().add([{ id: 'c-late', cliVersion: '0.2.2' }], { cli: true }).run();
    assert.equal(r.code, 1);
    assert.match(r.err, /c-late: claims 0\.2\.2, but [0-9a-f]{8} is not an ancestor of v0\.2\.2/);
});

test('a docs-only backfill naming an earlier tag is skipped', () => {
    const r = released().add([{ id: 'c-backfill', cliVersion: '0.2.1' }]).run();
    assert.equal(r.code, 0, r.err);
});

test('a bulk import of two versions in one CLI commit is skipped', () => {
    const r = released()
        .add([{ id: 'c-old', cliVersion: '0.2.1' }, { id: 'd-old', cliVersion: '0.2.2' }], { cli: true })
        .run();
    assert.equal(r.code, 0, r.err);
});

test('one CLI commit with two entries for the same version is still checked', () => {
    const r = released()
        .add([{ id: 'c-same', cliVersion: '0.2.2' }, { id: 'd-same', cliVersion: '0.2.2' }], { cli: true })
        .run();
    assert.equal(r.code, 1);
    assert.match(r.err, /c-same: claims 0\.2\.2/);
    assert.match(r.err, /d-same: claims 0\.2\.2/);
});

test('an untagged version behind the newest tag is a note, not a failure', () => {
    const r = repo()
        .add([{ id: 'a-orphan', cliVersion: '0.2.1' }], { cli: true })
        .cli()
        .tag('0.2.2')
        .run();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /note: 0\.2\.1 names no tag that was ever published \(historical\)/);
});

test('an id that is a prefix of a later id keeps its own introducing commit', () => {
    // `git log -S a-x` also matches the commit adding `a-x-more`; the oldest
    // match is still the one that introduced `a-x`, so a-x passes.
    const r = repo()
        .add([{ id: 'a-x', cliVersion: '0.2.1' }], { cli: true })
        .tag('0.2.1')
        .add([{ id: 'a-x-more', cliVersion: '0.2.2' }], { cli: true })
        .tag('0.2.2')
        .run();
    assert.equal(r.code, 0, r.err);
});

test('no tags at all is a no-op', () => {
    const r = repo().add([{ id: 'a', cliVersion: '0.2.1' }], { cli: true }).run();
    assert.equal(r.code, 0);
    assert.match(r.out, /no v\* tags yet/);
});

test('history is walked at most once per entry (B-955: was once per entry per commit)', { skip: !!process.env.CHECK_CHANGELOG_SCRIPT }, () => {
    let r = repo();
    for (let i = 1; i <= 12; i += 1) r = r.add([{ id: `e-${i}`, cliVersion: `0.2.${i}` }], { cli: true }).tag(`0.2.${i}`);
    const res = r.run();
    assert.equal(res.code, 0, res.err);
    assert.ok(res.pickaxe > 0, 'GIT_TRACE should see the pickaxe walks');
    assert.ok(res.pickaxe <= 12, `expected ≤ 12 history walks for 12 entries, got ${res.pickaxe}`);
});
