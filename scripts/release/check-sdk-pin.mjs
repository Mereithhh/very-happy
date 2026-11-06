#!/usr/bin/env node
// B-894: how far the CLI's exact @anthropic-ai/claude-agent-sdk pin lags npm.
// Web/remote Claude sessions run the native binary bundled with that SDK, so
// it only moves when someone bumps the pin (B-717 bumped 0.3.296 → 0.3.306 on
// 10-21; by 11-06 npm was at 0.3.319). Advisory only: it never fails a
// release — a pin is held on purpose for rollback-ability — it just says so,
// as a GitHub warning annotation in CI.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
export const WARN_BEHIND_RELEASES = 5;
export const WARN_BEHIND_DAYS = 14;

const parse = (v) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(v) ?? []).slice(1).map(Number);
const newer = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** Pure: the pin vs the registry document (`versions`, `time`, `dist-tags`). */
export function sdkPinFreshness({ pinned, registry, now = Date.now() }) {
    const latest = registry?.['dist-tags']?.latest ?? null;
    const stable = Object.keys(registry?.versions ?? {}).filter((v) => parse(v).length === 3);
    // Only releases up to the `latest` dist-tag count: a newer one not promoted yet is not "behind".
    const behind = stable.filter((v) => newer(v, pinned) && (!latest || !newer(v, latest))).sort((a, b) => (newer(a, b) ? 1 : -1));
    const firstNewerAt = behind.length ? Date.parse(registry?.time?.[behind[0]] ?? '') : NaN;
    const days = Number.isFinite(firstNewerAt) ? Math.floor((now - firstNewerAt) / 86_400_000) : 0;
    const stale = behind.length >= WARN_BEHIND_RELEASES || (behind.length > 0 && days >= WARN_BEHIND_DAYS);
    return { pinned, latest, behind: behind.length, days, stale };
}

export function message(r) {
    if (r.behind === 0) return `${SDK_PACKAGE} pin ${r.pinned} is current.`;
    return `${SDK_PACKAGE} pin ${r.pinned} is ${r.behind} release(s) behind ${r.latest ?? '?'} (first newer one ${r.days} day(s) ago).`
        + (r.stale ? ' Consider bumping it (and re-probe the bundled Claude Code) in the next CLI release.' : '');
}

async function main() {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const pkg = JSON.parse(readFileSync(join(root, 'packages/happy-cli/package.json'), 'utf8'));
    const pinned = pkg.dependencies?.[SDK_PACKAGE];
    let result;
    try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(SDK_PACKAGE).replace('%40', '@')}`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        result = sdkPinFreshness({ pinned, registry: await res.json() });
    } catch (error) {
        console.log(`SDK pin check skipped: registry unavailable (${error.message ?? error}).`);
        return;
    }
    const text = message(result);
    console.log(text);
    if (result.stale && process.env.GITHUB_ACTIONS) console.log(`::warning title=Claude SDK pin is behind::${text}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
