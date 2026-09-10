import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    session: { presence: 'online', thinking: true, thinkingStartedAt: 1000 },
    progress: {} as Record<string, number | string>,
    tool: null as null | { name: string; startedAt: number },
}));
vi.mock('@/sync/storage', () => ({ useSession: () => state.session, useSessionRunningTool: () => state.tool }));
vi.mock('@/sync/liveStreamStore', () => ({ useLiveStreamProgress: () => state.progress }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => true }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key.split('.').at(-1) }) }));
vi.mock('./useElapsed', () => ({ useElapsedSeconds: () => 14 }));
import { SessionLiveStatusBar } from './SessionLiveStatusBar';

const render = () => renderToStaticMarkup(<SessionLiveStatusBar sessionId="s" />);

describe('SessionLiveStatusBar', () => {
    it('shows usage inline without a disclosure and keeps metrics outside the live announcer', () => {
        state.progress = { inputTokens: 1200, outputTokens: 42, cacheTokens: 72000, thinkingTokens: 500 };
        const html = render();
        expect(html).toContain('liveInputTokens: 1.2k');
        expect(html).toContain('liveOutputTokens: 42');
        expect(html).toContain('liveCacheTokens: 72.0k');
        expect(html).toContain('liveThinkingTokens: ≈ 500');
        expect(html).toContain('lucide-arrow-up');
        expect(html).toContain('lucide-arrow-down');
        const announcement = html.match(/<span[^>]*role="status"[^>]*>(.*?)<\/span>/)?.[1];
        expect(announcement).toBe('liveProcessing');
        expect(html).toContain('14s');
        expect(html).toContain('class="lsb-orbit"');
        expect(html).not.toMatch(/<(details|summary|button)\b/);
        expect(html).not.toContain('aria-expanded');
        expect(html).not.toContain('lsb-chevron');
        expect(html).toMatch(/class="lsb-metric"[^>]*aria-label="liveInputTokens: 1.2k"/);
        expect(html).toMatch(/class="lsb-metric"[^>]*aria-label="liveOutputTokens: 42"/);
        expect(html).not.toContain('lucide-brain');
        expect(html).not.toContain('lucide-zap');
    });
    it('keeps a thinking-only runner estimate explicitly approximate', () => {
        state.progress = { thinkingTokens: 1230 };
        const html = render();
        expect(html).toContain('liveThinkingTokens: ≈ 1.2k');
        expect(html).toContain('lucide-brain');
        expect(html).not.toContain('lucide-arrow-down');
    });
    it('degrades to status/time and prioritises compaction over a tool', () => {
        state.progress = {};
        expect(render()).not.toContain('lsb-metrics');
        state.tool = { name: 'Bash', startedAt: 1000 };
        expect(render()).toContain('data-phase="tool"');
        state.progress = { status: 'compacting' };
        expect(render()).toContain('data-phase="compacting"');
        state.tool = null;
        state.progress = { status: 'requesting' };
        expect(render()).toContain('data-phase="requesting"');
    });
    it('never keeps the activity animation alive after the agent stops', () => {
        state.session.thinking = false;
        state.progress = { outputTokens: 100 };
        expect(render()).toBe('');
        state.session.thinking = true;
    });
});
