#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CATEGORY_ORDER = ['Features', 'Fixes', 'Performance'];
const TYPE_TO_CATEGORY = new Map([
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
]);

export function parseCommitLine(line) {
  const separator = line.indexOf('\t');
  if (separator <= 0) return null;
  const hash = line.slice(0, separator);
  const subject = line.slice(separator + 1).trim();
  const match = /^(feat|fix|perf)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(subject);
  if (!match) return null;
  return {
    hash,
    type: match[1],
    scope: match[2] ?? null,
    breaking: Boolean(match[3]),
    subject: match[4].replace(/\s+\(#\d+\)$/, ''),
  };
}

export function buildDraft(lines, from, to) {
  const groups = new Map(CATEGORY_ORDER.map((category) => [category, []]));
  for (const line of lines) {
    const commit = parseCommitLine(line);
    if (!commit) continue;
    groups.get(TYPE_TO_CATEGORY.get(commit.type)).push(commit);
  }
  const count = [...groups.values()].reduce((sum, commits) => sum + commits.length, 0);
  const markdown = [
    `# Changelog draft: ${from}…${to}`,
    '',
    '> Generated from conventional commit subjects. Review, rewrite for users, translate, and add a stable release id before publishing.',
    '',
  ];
  for (const category of CATEGORY_ORDER) {
    const commits = groups.get(category);
    if (commits.length === 0) continue;
    markdown.push(`## ${category}`, '');
    for (const commit of commits) {
      const scope = commit.scope ? `**${commit.scope}:** ` : '';
      const breaking = commit.breaking ? '**BREAKING** ' : '';
      markdown.push(`- ${breaking}${scope}${commit.subject} (${commit.hash})`);
    }
    markdown.push('');
  }
  if (count === 0) markdown.push('_No user-facing feat/fix/perf commits found._', '');
  return { from, to, count, groups: Object.fromEntries(groups), markdown: markdown.join('\n') };
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const to = readArg('--to') ?? 'HEAD';
  const from = readArg('--from') ?? git(['describe', '--tags', '--abbrev=0', '--match', 'v*', to]);
  const json = process.argv.includes('--json');
  const raw = git(['log', '--no-merges', '--format=%h%x09%s', `${from}..${to}`]);
  const draft = buildDraft(raw ? raw.split('\n') : [], from, to);
  process.stdout.write(json ? `${JSON.stringify(draft, null, 2)}\n` : `${draft.markdown}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`changelog-draft: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
