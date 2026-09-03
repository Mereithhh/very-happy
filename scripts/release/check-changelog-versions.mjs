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
