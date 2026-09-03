#!/usr/bin/env node
/**
 * B-348 — did the release actually reach anyone?
 *
 * Publishing to npm does not tell a single user to upgrade. That happens only
 * when the relay's `/v1/version/cli` names the new version: answer nulls and
 * `deriveCliUpdateState` returns null, so every banner, badge and machine-page
 * row stays empty. It was never set at all until 2026-09-03 — the notice
 * machinery from B-040 had shipped and been silent ever since, while the fleet
 * drifted two dozen versions behind — and then it was forgotten again on the
 * next release.
 *
 * ── What changed under this check, same day (#243) ─────────────────────────
 * The recommendation is no longer a manual pin. `publish.yml` publishes the
 * main package under `next`, its `promote` job moves the `latest` dist-tag only
 * after the smoke matrix for that commit is green, and the relay follows
 * `latest` (`CLI_VERSION_REGISTRY_LOOKUP=true`), cached for up to an hour.
 *
 * So "the relay does not name the published version yet" is now the NORMAL
 * state for the first hour, and shouting about it — with instructions to hand-
 * edit `/opt/happy/.env`, which the runbook no longer asks for — would make
 * this check cry wolf on literally every release. That is the failure mode this
 * check was written to avoid, so it now separates the three cases the answer
 * can actually be in:
 *
 *   - pinned to something else   → nobody will be offered this release. Loud.
 *   - following the dist-tag, and `latest` IS this version → it lands within
 *     the hour by itself. Informational.
 *   - following the dist-tag, but `latest` is NOT this version → `promote` did
 *     not run or smoke was red. Loud, and points at the job, not at the env
 *     file: a red smoke run is the gate working, and hand-moving the dist-tag
 *     to get past it is exactly the thing the gate exists to prevent.
 *
 * It reports rather than fails throughout: publishing without promoting is a
 * legitimate choice (a release held back for validation), and a red X on a
 * successful publish would train people to ignore it. What it must not be is
 * silent, and what it must not be is wrong.
 */
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const origin = process.env.VH_PUBLIC_ORIGIN ?? 'https://veryhappy.dev';
const published = process.argv[2];

if (!published) {
    console.error('usage: check-recommended.mjs <published-version>');
    process.exit(2);
}

/** The `latest` dist-tag, or null when npm cannot be reached. */
function npmLatest() {
    try {
        return execFileSync('npm', ['view', 'very-happy-cli', 'version'], {
            encoding: 'utf8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
        return null;
    }
}

/** Loud enough to survive log truncation: stdout AND the run summary. */
function report(lines) {
    for (const line of lines) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    }
}

try {
    const res = await fetch(`${origin}/v1/version/cli`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
        console.log(`⚠️  could not read ${origin}/v1/version/cli (HTTP ${res.status}) — check the policy by hand`);
        process.exit(0);
    }
    const policy = await res.json();
    const recommended = policy?.recommendedVersion ?? null;
    const source = policy?.source ?? 'unavailable';

    if (recommended === published) {
        console.log(`✅ relay recommends ${published} — this release is being offered to users`);
        process.exit(0);
    }

    if (source === 'registry') {
        const latest = npmLatest();
        if (latest === published) {
            console.log(`✅ promoted: npm latest = ${published}; the relay still says ${recommended ?? 'nothing'}`);
            console.log('   It follows the dist-tag with a one-hour cache, so it picks this up on its own. Nothing to do.');
            process.exit(0);
        }
        report([
            `## ⚠️ Published ${published}, but npm \`latest\` is ${latest ?? 'unreadable'}`,
            '',
            'The relay follows the `latest` dist-tag, so **until it moves, no user is',
            'told this release exists**. `latest` moves in this workflow\'s `promote`',
            'job, which waits for the CLI smoke matrix on this commit.',
            '',
            'Read that job before doing anything by hand. The usual cause is a red',
            'smoke run — and that is the gate working. Do **not** `npm dist-tag add`',
            'past it; if the release must go out regardless, pin the relay',
            'deliberately instead, so the decision is recorded:',
            '',
            '```sh',
            'ssh vh-us',
            `sed -i 's|^# *CLI_RECOMMENDED_VERSION=.*|CLI_RECOMMENDED_VERSION=${published}|' /opt/happy/.env`,
            '# the candidate reads env at start, so deploy to pick it up:',
            'gh workflow run deploy-hwsg.yml --ref main -f target=all -f rollout=switch',
            '```',
        ]);
        process.exit(0);
    }

    // `configured` (an explicit pin) or `unavailable` (nothing pinned, lookup
    // off). Both mean a human decision is holding the fleet where it is.
    report([
        `## ⚠️ Published ${published}, but the relay ${source === 'configured'
            ? `is pinned to ${recommended}`
            : 'recommends nothing at all'}`,
        '',
        'Until that changes, **no user is told this release exists** — every update',
        'surface reads the recommendation, and an unset one means silence.',
        '',
        source === 'configured'
            ? 'A pin always beats the dist-tag lookup. Drop it to let the relay follow'
            : 'Neither a pin nor the registry lookup is set. Turn the lookup on to follow',
        source === 'configured'
            ? 'promoted releases again, or move it to this version:'
            : 'promoted releases, or pin this version explicitly:',
        '',
        '```sh',
        'ssh vh-us',
        source === 'configured'
            ? "sed -i 's|^CLI_RECOMMENDED_VERSION=|# CLI_RECOMMENDED_VERSION=|' /opt/happy/.env   # follow the dist-tag again"
            : "grep -q '^CLI_VERSION_REGISTRY_LOOKUP=' /opt/happy/.env || echo 'CLI_VERSION_REGISTRY_LOOKUP=true' >> /opt/happy/.env",
        '# the candidate reads env at start, so deploy to pick it up:',
        'gh workflow run deploy-hwsg.yml --ref main -f target=all -f rollout=switch',
        '```',
    ]);
    process.exit(0);
} catch (error) {
    console.log(`⚠️  relay check failed (${error?.message ?? error}) — verify the policy by hand`);
    process.exit(0);
}
