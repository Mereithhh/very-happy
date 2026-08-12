/**
 * Version gate for the assistant form (B-051): the daemon must be new enough
 * to understand the `variant: 'assistant'` spawn field (dedupe + own cwd).
 * Pure module — unit-tested in assistantSupport.test.ts.
 */

import { ASSISTANT_MIN_CLI_VERSION } from './assistantConstants';

/**
 * Loose semver comparison over dotted numeric segments. Non-numeric suffixes
 * are ignored per segment ("0.2.34-beta" → 0.2.34); missing segments count
 * as 0. Returns <0 / 0 / >0.
 */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string): number[] =>
        v
            .trim()
            .replace(/^v/i, '')
            .split('.')
            .map((seg) => {
                const n = parseInt(seg, 10);
                return Number.isFinite(n) ? n : 0;
            });
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const da = pa[i] ?? 0;
        const db = pb[i] ?? 0;
        if (da !== db) return da - db;
    }
    return 0;
}

/**
 * Whether a machine's happy-cli version supports the assistant session.
 * Unknown / unparsable versions gate CLOSED (show the upgrade hint rather
 * than blind-spawning against an old daemon).
 */
export function isAssistantSupported(version: string | null | undefined): boolean {
    if (!version || typeof version !== 'string') return false;
    if (!/^v?\d/.test(version.trim())) return false;
    return compareVersions(version, ASSISTANT_MIN_CLI_VERSION) >= 0;
}
