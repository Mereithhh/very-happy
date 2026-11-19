// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ session: null as any }));
vi.mock('@/sync/storage', () => ({ useSession: () => mock.session }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, p?: Record<string, unknown>) => (p ? `${key}:${JSON.stringify(p)}` : key) }) }));
import { OversizeSkippedBanner } from './OversizeSkippedBanner';
import { en } from '@/text/_default';
import { zhHans } from '@/text/translations/zh-Hans';

let host: HTMLDivElement, root: Root;
const render = () => act(() => root.render(<OversizeSkippedBanner sessionId="s1" />));

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    mock.session = { oversizeSkipped: undefined };
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('nothing skipped (or an older server): no strip', () => {
    render();
    expect(host.querySelector('[data-testid="oversize-skipped-banner"]')).toBeNull();
    mock.session = { oversizeSkipped: 0 };
    render();
    expect(host.querySelector('[data-testid="oversize-skipped-banner"]')).toBeNull();
});

it('says how many records are missing; hiding it lasts until another one is skipped', () => {
    mock.session = { oversizeSkipped: 2 };
    render();
    expect(host.textContent).toContain('session.chat.oversizeSkipped:{"count":2}');
    act(() => host.querySelector<HTMLButtonElement>('.mrb-dismiss')!.click());
    expect(host.querySelector('[data-testid="oversize-skipped-banner"]')).toBeNull();
    // Remembered across a reload…
    act(() => root.unmount()); root = createRoot(host); render();
    expect(host.querySelector('[data-testid="oversize-skipped-banner"]')).toBeNull();
    // …and shown again when the count grows.
    mock.session = { oversizeSkipped: 3 };
    render();
    expect(host.textContent).toContain('"count":3');
});

it('the wording says how large, why, and that what follows is there', () => {
    const enText = (en as any).session.chat.oversizeSkipped({ count: 1 });
    expect(enText).toBe("1 record from this session was too large to sync (over the server's 1 MB limit per record) and is missing here. Everything after it is shown.");
    expect((en as any).session.chat.oversizeSkipped({ count: 3 })).toContain('3 records from this session were too large');
    expect((zhHans as any).session.chat.oversizeSkipped({ count: 2 })).toContain('2 条记录太大');
});
