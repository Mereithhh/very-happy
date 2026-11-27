// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeView } from '@slopus/happy-wire';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'zh-Hans' }) }));
vi.mock('@/sync/storage', () => ({ storage: Object.assign(() => true, { getState: () => ({ settings: {} }) }), useSetting: () => [] }));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: vi.fn(), onResume: () => () => undefined } }));
vi.mock('@/sync/apiNotices', () => ({ fetchNotices: async () => [] }));
vi.mock('./globalNotice.css', () => ({}));
vi.mock('../floatingCards.css', () => ({}));

const { GlobalNoticeCard } = await import('./GlobalNotice');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function render(notice: NoticeView, onDismiss = vi.fn(), onClose = vi.fn()) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<GlobalNoticeCard notice={notice} onDismiss={onDismiss} onClose={onClose} />));
    return { card: host.querySelector('.gn-card')!, onDismiss, onClose };
}

describe('GlobalNoticeCard', () => {
    it('a dismissible notice offers 知道了 and no close button; the body links URLs', () => {
        const { card, onDismiss } = render({ id: 'a', title: '维护通知', body: '详情 https://status.example.com', level: 'info', dismissible: true });
        expect(card.getAttribute('data-level')).toBe('info');
        expect(card.querySelector('.gn-close')).toBeNull();
        expect(card.querySelector('a')?.getAttribute('href')).toBe('https://status.example.com');
        expect(card.querySelector('a')?.getAttribute('rel')).toContain('noopener');
        act(() => (card.querySelector('.gn-dismiss') as HTMLButtonElement).click());
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('a notice that cannot be dismissed only closes for now', () => {
        const { card, onClose } = render({ id: 'b', title: 'Outage', body: '', level: 'warning', dismissible: false });
        expect(card.getAttribute('data-level')).toBe('warning');
        expect(card.querySelector('.gn-dismiss')).toBeNull();
        expect(card.querySelector('.gn-body')).toBeNull();
        act(() => (card.querySelector('.gn-close') as HTMLButtonElement).click());
        expect(onClose).toHaveBeenCalledOnce();
    });
});
