#!/usr/bin/env node
/**
 * B-348 — did the release actually reach anyone?
 *
 * Publishing to npm does not tell a single user to upgrade. That happens only
 * when the relay's `CLI_RECOMMENDED_VERSION` names the new version: unset, the
 * relay answers `/v1/version/cli` with nulls, `deriveCliUpdateState` returns
 * null, and every banner, badge and machine-page row stays empty.
 *
 * It was never set at all until 2026-09-03 — the notice machinery from B-040
 * had shipped and been silent ever since, while the fleet drifted two dozen
 * versions behind — and then it was forgotten again on the next release. A step
 * that is only written in a runbook is a step that gets skipped.
 *
 * This reports rather than fails: publishing without promoting is a legitimate
 * choice (a release held back for validation), and a red X on a successful
 * publish would train people to ignore it. What it must not be is silent.
 */
const origin = process.env.VH_PUBLIC_ORIGIN ?? 'https://veryhappy.dev';
const published = process.argv[2];

if (!published) {
    console.error('usage: check-recommended.mjs <published-version>');
    process.exit(2);
}

import { appendFileSync } from 'node:fs';

try {
    const res = await fetch(`${origin}/v1/version/cli`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
        console.log(`⚠️  could not read ${origin}/v1/version/cli (HTTP ${res.status}) — check the pin by hand`);
        process.exit(0);
    }
    const policy = await res.json();
    const recommended = policy?.recommendedVersion ?? null;
    if (recommended === published) {
        console.log(`✅ relay recommends ${published} — this release will be offered to users`);
        process.exit(0);
    }
    const lines = [
        `## ⚠️ Published ${published}, but the relay still recommends ${recommended ?? 'nothing'}`,
        '',
        'Until the relay is updated, **no user is told this release exists** — every',
        'update banner reads the recommendation, and an unset one means silence.',
        '',
        '```sh',
        'ssh vh-us',
        `sed -i 's|^CLI_RECOMMENDED_VERSION=.*|CLI_RECOMMENDED_VERSION=${published}|' /opt/happy/.env`,
        '# the candidate reads env at start, so deploy to pick it up:',
        'gh workflow run deploy-hwsg.yml --ref main -f target=all -f rollout=switch',
        '```',
    ];
    for (const line of lines) console.log(line);
    // Surface it in the run summary too, where it survives log truncation.
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    }
    process.exit(0);
} catch (error) {
    console.log(`⚠️  relay check failed (${error?.message ?? error}) — verify the pin by hand`);
    process.exit(0);
}
