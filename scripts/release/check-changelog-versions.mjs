#!/usr/bin/env node
/**
 * B-348 — a `cliVersion` in the changelog is a prediction, and predictions rot.
 *
 * Every entry names the CLI release it ships in, but that number is written
 * before the tag exists. Twice on 2026-09-03 it was wrong in opposite
 * directions: once naming a version a parallel session had already published
 * (so the entry pointed at a release that did not contain the work), once
 * naming 0.2.121 when the next tag was 0.2.115 (a number invented out of the
 * air). Both were caught by the release gate — at release time, after review,
 * when the fix costs another round trip.
 *
 * This runs on every PR instead. A `cliVersion` is legitimate when it either
 * names a tag that exists (an entry for something already released) or is the
 * very next patch after the newest tag (an entry for the release being
 * prepared). Anything else is a guess, and guesses are what this catches.
 *
 * ── The third shape: naming a tag that does not contain you (B-347) ────────
 * "Names a tag that exists" was not enough. `2026-09-04-pi-and-supervisor-
 * surface` claimed 0.2.116 while its code landed AFTER v0.2.116, so users
 * upgrading to 0.2.116 were told they had pi-agent features that were not in
 * it. `check-release.mjs` cannot see this — it verifies that SOME entry carries
 * the version, never that the entry's own work is inside it.
 *
 * The mechanical version of that question: find the commit that introduced the
 * entry, and require it to be an ancestor of the tag it claims. That proxy only
 * holds when the entry shipped WITH its own code, so two kinds of commit are
 * skipped rather than guessed at:
 *   - docs-only ones — a backfill describing work that shipped earlier (#238),
 *     with nothing in the entry tying it to that work;
 *   - ones introducing entries for two or more DIFFERENT versions at once —
 *     that is a bulk import of history, not a release (99decb3f added the
 *     changelog file itself with four past releases in it).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHANGELOG = 'packages/happy-web-v2/src/app/changelogRelease.ts';

function tags() {
    const out = execFileSync('git', ['tag', '--list', 'v*.*.*'], { encoding: 'utf8' });
    return new Set(out.split('\n').map((line) => line.trim().replace(/^v/, '')).filter(Boolean));
}

function parse(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a, b) {
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

const known = tags();
const parsedTags = [...known].map(parse).filter(Boolean);
if (parsedTags.length === 0) {
    console.log('no v* tags yet — nothing to check');
    process.exit(0);
}
const newest = parsedTags.sort(compare).at(-1);
const nextPatch = [newest[0], newest[1], newest[2] + 1].join('.');
const newestTag = newest.join('.');

const source = readFileSync(CHANGELOG, 'utf8');
const declared = [...source.matchAll(/^\s*cliVersion:\s*'([^']+)'/gm)].map((m) => m[1]);

/** `[{ id, cliVersion }]` — an entry runs from its `id:` to the next one. */
function entriesWithCliVersion() {
    const out = [];
    const ids = [...source.matchAll(/^\s*id:\s*'([^']+)'/gm)];
    ids.forEach((match, i) => {
        const body = source.slice(match.index, ids[i + 1]?.index ?? source.length);
        const version = /^\s*cliVersion:\s*'([^']+)'/m.exec(body)?.[1];
        if (version) out.push({ id: match[1], cliVersion: version });
    });
    return out;
}

function git(args) {
    try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

/** The commit that first put this entry id into the changelog, or null. */
function introducedBy(id) {
    const log = git(['log', '--format=%H', '-S', id, '--', CHANGELOG]);
    return log ? log.split('\n').filter(Boolean).at(-1) ?? null : null;
}

/** How many distinct cliVersions this commit introduced — >1 means a backfill. */
const versionsByCommit = new Map();
function versionsIntroducedBy(commit) {
    let versions = versionsByCommit.get(commit);
    if (!versions) {
        versions = new Set();
        for (const entry of entriesWithCliVersion()) {
            if (introducedBy(entry.id) === commit) versions.add(entry.cliVersion);
        }
        versionsByCommit.set(commit, versions);
    }
    return versions;
}

/** Did that commit carry CLI code, i.e. is it the work the entry describes? */
function touchesCli(commit) {
    const files = git(['show', '--stat', '--format=', '--name-only', commit]);
    return !!files && files.split('\n').some((f) => /^packages\/happy-(cli|wire)\//.test(f));
}

// Fail only on numbers that run AHEAD of what could possibly ship next. That is
// the mistake an author can still make today — inventing a version before the
// tag exists — and it is unambiguous.
//
// A version at or below the newest tag with no tag of its own is also wrong, but
// it is only ever wrong in hindsight (a parallel session published that number
// first), the release gate refuses it at tag time anyway, and history already
// contains one from 2026-08-24. Report those; do not fail on them, because a
// check that fails on commits nobody can change is a check people learn to skip.
const ahead = [];
const orphaned = [];
for (const version of new Set(declared)) {
    if (version === nextPatch || known.has(version)) continue;
    const parsedVersion = parse(version);
    if (parsedVersion && compare(parsedVersion, newest) > 0) ahead.push(version);
    else orphaned.push(version);
}

for (const version of orphaned) {
    console.log(`note: ${version} names no tag that was ever published (historical)`);
}

// B-347: an entry that shipped with its own code must be inside the tag it
// names. Needs real history; a shallow clone can only be told that, not lied to.
const shipped = [];
if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    console.log('note: shallow clone — skipping the "entry is inside the tag it claims" check');
} else {
    for (const entry of entriesWithCliVersion()) {
        if (!known.has(entry.cliVersion)) continue; // no tag yet: the checks above own it
        const commit = introducedBy(entry.id);
        if (!commit || !touchesCli(commit)) continue; // backfill, or unknowable
        if (versionsIntroducedBy(commit).size > 1) continue; // bulk history import
        if (git(['merge-base', '--is-ancestor', commit, `v${entry.cliVersion}`]) === null) {
            shipped.push({ ...entry, commit });
        }
    }
}

if (shipped.length > 0) {
    console.error('changelog cliVersion check failed: an entry names a release it is not in');
    for (const { id, cliVersion, commit } of shipped) {
        console.error(`  ${id}: claims ${cliVersion}, but ${commit.slice(0, 8)} is not an ancestor of v${cliVersion}`);
    }
    console.error('');
    console.error('Users upgrading to that version are promised work it does not contain.');
    console.error('Point the entry at the release that will actually carry it.');
    process.exit(1);
}

if (ahead.length === 0) {
    console.log(`✅ no cliVersion runs ahead of the next release (${nextPatch})`);
    process.exit(0);
}

console.error(`changelog cliVersion check failed (newest tag v${newestTag})`);
for (const version of ahead) {
    console.error(`  ${version}: ahead of the next patch — the next release is ${nextPatch}`);
}
console.error('');
console.error(`An entry ships either in a release that exists, or in ${nextPatch}.`);
console.error('A larger number was guessed before the tag existed.');
process.exit(1);
