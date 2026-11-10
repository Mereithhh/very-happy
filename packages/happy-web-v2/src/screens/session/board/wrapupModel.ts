/**
 * B-915 — reading a `wrapup` board item (pure). The payload is the agent's
 * `wrapup_report` / handoff result (`AttentionWrapupPayloadSchema` in
 * happy-wire), read leniently: an unknown mode / status / delivery value from
 * a newer CLI degrades to a plain card instead of breaking the board.
 */
import { parseWrapupPayload, type AttentionItem, type WrapupPayloadView } from '@slopus/happy-wire';

export type WrapupHeadline =
    | { key: 'running'; mode: 'wrapup' | 'handoff'; target: string | null }
    | { key: 'canClose' }
    | { key: 'pending'; count: number }
    | { key: 'notYet' }
    | { key: 'delivered'; target: string }
    | { key: 'stored'; target: string }
    | { key: 'handoffFailed'; target: string };

export interface WrapupView {
    payload: WrapupPayloadView;
    mode: 'wrapup' | 'handoff';
    running: boolean;
    headline: WrapupHeadline;
    /** Handoff delivery failed: the card is marked in danger red. */
    failed: boolean;
    uncheckedCount: number;
}

export function wrapupView(item: Pick<AttentionItem, 'kind' | 'payload'>): WrapupView | null {
    if (item.kind !== 'wrapup') return null;
    const payload = parseWrapupPayload(item.payload);
    if (!payload) return null;
    const mode = payload.mode === 'handoff' ? 'handoff' : 'wrapup';
    const running = payload.status === 'running';
    const target = payload.handoff ? (payload.handoff.toTitle?.trim() || payload.handoff.to) : null;
    const uncheckedCount = (payload.pending ?? []).filter((p) => !p.checked).length;
    const delivery = payload.handoff?.delivery;
    const failed = mode === 'handoff' && !running && (payload.status === 'failed' || delivery === 'failed');
    let headline: WrapupHeadline;
    if (running) headline = { key: 'running', mode, target };
    else if (mode === 'handoff') {
        const t = target ?? '';
        headline = failed ? { key: 'handoffFailed', target: t } : delivery === 'offline-stored' ? { key: 'stored', target: t } : { key: 'delivered', target: t };
    } else if (uncheckedCount > 0) headline = { key: 'pending', count: uncheckedCount };
    else if (payload.canClose === false) headline = { key: 'notYet' };
    else headline = { key: 'canClose' };
    return { payload, mode, running, headline, failed, uncheckedCount };
}

/**
 * GitHub commit link when the repo is known: `owner/name`, an https URL or an
 * ssh remote (`git@github.com:owner/name.git`). Anything else → null (short sha only).
 */
export function commitUrl(repo: string | undefined, sha: string): string | null {
    if (!repo || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
    const r = repo.trim();
    const m = r.match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
    if (!m) return null;
    // A bare `a/b` is GitHub shorthand; a URL to another host never matches the pattern above.
    return `https://github.com/${m[1]}/${m[2]}/commit/${sha}`;
}

export function shortSha(sha: string): string {
    return sha.slice(0, 7);
}
