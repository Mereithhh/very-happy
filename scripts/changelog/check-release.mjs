#!/usr/bin/env node
/**
 * Changelog coverage gate — fails a release that ships user-facing commits
 * without a matching CHANGELOG_RELEASES entry.
 *
 *   web: node scripts/changelog/check-release.mjs --mode web --live https://veryhappy.dev --sha <sha>
 *        Live release SHA is read from the public entry asset name
 *        (`/assets/index-<hash>-<sha>.js`), so no credentials are needed.
 *        Fails when `live..sha` contains feat/fix/perf commits touching the
 *        shipped packages (web/server/wire) but the changelog head id is
 *        unchanged.
 *   cli: node scripts/changelog/check-release.mjs --mode cli --version X.Y.Z [--sha <ref>]
 *        Fails when packages/happy-cli|happy-wire have feat/fix/perf commits
 *        since the previous v* tag and no entry carries cliVersion 'X.Y.Z'.
 *
 * Escape hatches (always logged): `--skip "<reason>"`, or for CLI tags an
 * annotated tag message containing `[changelog-skip: <reason>]`.
 * On failure the conventional-commit draft is printed so the entry can be
 * written immediately.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildDraft, parseCommitLine } from './generate-draft.mjs';

export const CHANGELOG_SOURCE = 'packages/happy-web-v2/src/app/changelogRelease.ts';
export const CLI_PATHS = ['packages/happy-cli', 'packages/happy-wire'];
// What the server/web image actually ships. CI/release tooling, docs and
// scripts are not user-facing even when their commit says fix(...).
export const WEB_PATHS = ['packages/happy-web-v2', 'packages/happy-server', 'packages/happy-wire'];

export function parseLiveReleaseSha(html) {
  const match = /\/assets\/index-[A-Za-z0-9_-]+-([0-9a-f]{40})\.js/.exec(html ?? '');
  return match ? match[1] : null;
}

/** Ordered `{ id, cliVersion }` list parsed from changelogRelease.ts (newest first). */
export function extractReleases(source) {
  const releases = [];
  const pattern = /^\s*id:\s*'([^']+)'|^\s*cliVersion:\s*'([^']+)'/gm;
  let match;
  while ((match = pattern.exec(source ?? ''))) {
    if (match[1]) releases.push({ id: match[1], cliVersion: null });
    else if (releases.length > 0) releases[releases.length - 1].cliVersion = match[2];
  }
  return releases;
}

export function userFacingCommits(lines) {
  return lines.map(parseCommitLine).filter(Boolean);
}

export function evaluateWebRelease({ commits, liveReleases, targetReleases }) {
  const facing = userFacingCommits(commits);
  const added = targetReleases
    .filter((release) => !liveReleases.some((live) => live.id === release.id))
    .map((release) => release.id);
  const head = targetReleases[0]?.id ?? '(none)';
  if (facing.length === 0) {
    return { ok: true, facing, added, reason: 'no user-facing feat/fix/perf commits since the live release' };
  }
  if (added.length > 0) {
    return { ok: true, facing, added, reason: `changelog adds ${added.join(', ')}` };
  }
  return {
    ok: false,
    facing,
    added,
    reason: `${facing.length} user-facing commit(s) since the live release, but CHANGELOG_RELEASES head is still "${head}"`,
  };
}

export function evaluateCliRelease({ version, commits, releases }) {
  const facing = userFacingCommits(commits);
  const entry = releases.find((release) => release.cliVersion === version);
  if (entry) return { ok: true, facing, reason: `changelog entry "${entry.id}" carries cliVersion ${version}` };
  if (facing.length === 0) {
    return { ok: true, facing, reason: 'no user-facing feat/fix/perf commits under the CLI packages since the previous tag' };
  }
  return {
    ok: false,
    facing,
    reason: `${facing.length} user-facing CLI commit(s) since the previous tag, but no CHANGELOG_RELEASES entry has cliVersion '${version}'`,
  };
}

export function parseSkipReason(tagMessage) {
  const match = /\[changelog-skip:\s*([^\]]+)\]/.exec(tagMessage ?? '');
  return match ? match[1].trim() : null;
}

export function normalizeVersion(version) {
  return String(version ?? '').trim().replace(/^v/, '');
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.replace(/\n$/, '');
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function commitLines(range, paths = []) {
  const raw = git(['log', '--no-merges', '--format=%h%x09%s', range, ...(paths.length ? ['--', ...paths] : [])]);
  return raw ? raw.split('\n') : [];
}

function releasesAt(ref) {
  const source = git(['show', `${ref}:${CHANGELOG_SOURCE}`], { allowFailure: true });
  if (source === null) throw new Error(`cannot read ${CHANGELOG_SOURCE} at ${ref} (missing commit? run git fetch --unshallow)`);
  return extractReleases(source);
}

async function checkWeb({ live, sha }) {
  if (!live) throw new Error('--live <origin> is required in web mode');
  const response = await fetch(`${live.replace(/\/$/, '')}/`);
  if (!response.ok) throw new Error(`GET ${live}/ → ${response.status}`);
  const liveSha = parseLiveReleaseSha(await response.text());
  if (!liveSha) throw new Error(`could not find the live release SHA in the entry asset name at ${live}`);
  const target = git(['rev-parse', '--verify', `${sha}^{commit}`]);
  const known = git(['cat-file', '-e', `${liveSha}^{commit}`], { allowFailure: true });
  if (known === null) throw new Error(`live release ${liveSha} is not in this clone; run git fetch --unshallow origin`);
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', liveSha, target]).status === 0;
  const lines = [`live release: ${liveSha}`, `target:       ${target}`];
  if (!ancestor) {
    return {
      ok: false,
      facing: [],
      added: [],
      lines,
      reason: 'the live release is not an ancestor of the target (rollback or diverged history) — the diff is undefined; rerun with an explicit skip reason if this is intended',
      range: null,
    };
  }
  const commits = commitLines(`${liveSha}..${target}`, WEB_PATHS);
  const verdict = evaluateWebRelease({ commits, liveReleases: releasesAt(liveSha), targetReleases: releasesAt(target) });
  return { ...verdict, lines, range: `${liveSha.slice(0, 8)}..${target.slice(0, 8)}` };
}

function previousTag(sha, version) {
  const tags = (git(['tag', '--sort=-v:refname', '--merged', sha, '-l', 'v*']) || '').split('\n').filter(Boolean);
  return tags.find((tag) => normalizeVersion(tag) !== version) ?? null;
}

function checkCli({ version, sha }) {
  if (!version) throw new Error('--version X.Y.Z is required in cli mode');
  const target = git(['rev-parse', '--verify', `${sha}^{commit}`]);
  const prev = previousTag(target, version);
  const range = prev ? `${prev}..${target}` : target;
  const commits = commitLines(range, CLI_PATHS);
  const verdict = evaluateCliRelease({ version, commits, releases: releasesAt(target) });
  const tagMessage = git(['tag', '-l', '--format=%(contents)', `v${version}`], { allowFailure: true });
  return {
    ...verdict,
    range: prev ? `${prev}..${target.slice(0, 8)}` : `(no previous v* tag)..${target.slice(0, 8)}`,
    lines: [`previous tag: ${prev ?? '(none)'}`, `target:       ${target}`, `version:      ${version}`],
    tagSkipReason: parseSkipReason(tagMessage),
  };
}

async function main() {
  const mode = readArg('--mode');
  const sha = readArg('--sha') ?? 'HEAD';
  const explicitSkip = readArg('--skip');
  let result;
  if (mode === 'web') result = await checkWeb({ live: readArg('--live'), sha });
  else if (mode === 'cli') result = checkCli({ version: normalizeVersion(readArg('--version')), sha });
  else throw new Error('usage: check-release.mjs --mode web|cli [--live <origin>] [--version X.Y.Z] [--sha <ref>] [--skip "<reason>"]');

  const out = (line = '') => process.stdout.write(`${line}\n`);
  out(`changelog gate (${mode})`);
  for (const line of result.lines) out(`  ${line}`);
  if (result.range) out(`  range:        ${result.range}`);
  out(`  user-facing:  ${result.facing.length}`);
  out(`  verdict:      ${result.ok ? 'OK' : 'FAIL'} — ${result.reason}`);

  if (result.ok) return;

  const skip = (explicitSkip && explicitSkip.trim()) || result.tagSkipReason;
  if (skip) {
    out(`  SKIPPED:      ${skip}`);
    out('::warning::changelog gate skipped: ' + skip);
    return;
  }
  if (result.facing.length > 0) {
    out();
    const [from = '', to = ''] = (result.range ?? '').split('..');
    out(buildDraft(result.facing.map((c) => `${c.hash}\t${c.type}${c.scope ? `(${c.scope})` : ''}${c.breaking ? '!' : ''}: ${c.subject}`), from, to).markdown);
    out(`Add a release to CHANGELOG_RELEASES in ${CHANGELOG_SOURCE} (+ text keys in _default.ts and zh-Hans.ts)${mode === 'cli' ? ` with cliVersion '${normalizeVersion(readArg('--version'))}'` : ''}, or rerun with --skip "<reason>".`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`changelog gate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
