// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { NetworkBanner, NETWORK_BANNER_FADE_MS } from './NetworkBanner';
import { networkStore } from '@/sync/networkStatus';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    networkStore.setState({ phase: 'online' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); networkStore.setState({ phase: 'online' }); });

const bar = () => host.querySelector<HTMLElement>('.net-bar');

describe('NetworkBanner (B-799)', () => {
    it('shows 「已离线，正在重连…」, then 「已恢复」, then fades out and gives the shell its row back', () => {
        act(() => root.render(<NetworkBanner />));
        expect(bar()).toBeNull();
        expect(document.documentElement.hasAttribute('data-net-bar')).toBe(false);

        act(() => networkStore.setState({ phase: 'offline' }));
        expect(bar()!.dataset.netPhase).toBe('offline');
        expect(bar()!.textContent).toBe('network.offline');
        expect(bar()!.getAttribute('role')).toBe('status');
        expect(document.documentElement.hasAttribute('data-net-bar')).toBe(true);

        act(() => networkStore.setState({ phase: 'recovered' }));
        expect(bar()!.textContent).toBe('network.recovered');

        act(() => networkStore.setState({ phase: 'online' }));
        expect(bar()!.classList.contains('is-leaving')).toBe(true); // fading, still holding its row
        expect(document.documentElement.hasAttribute('data-net-bar')).toBe(true);
        act(() => { vi.advanceTimersByTime(NETWORK_BANNER_FADE_MS); });
        expect(bar()).toBeNull();
        expect(document.documentElement.hasAttribute('data-net-bar')).toBe(false);
    });

    it('a drop during the fade brings it straight back', () => {
        act(() => root.render(<NetworkBanner />));
        act(() => networkStore.setState({ phase: 'offline' }));
        act(() => networkStore.setState({ phase: 'online' }));
        act(() => networkStore.setState({ phase: 'offline' }));
        act(() => { vi.advanceTimersByTime(NETWORK_BANNER_FADE_MS * 2); });
        expect(bar()!.classList.contains('is-leaving')).toBe(false);
        expect(bar()!.dataset.netPhase).toBe('offline');
    });
});

describe('net bar layout (B-799)', () => {
    const css = readFileSync(resolve(__dirname, 'networkBanner.css'), 'utf8');
    const layout = readFileSync(resolve(__dirname, '../screens/AppLayout.tsx'), 'utf8');

    it('runs under the top inset and keeps its text clear of all side insets', () => {
        expect(css).toContain('height: calc(var(--sa-t) + var(--net-bar-h));');
        expect(css).toContain('padding: var(--sa-t) calc(var(--sa-r) + 12px) 0 calc(var(--sa-l) + 12px);');
    });

    it('moves the shell (and the floating drawer) down by its own height instead of covering headers', () => {
        expect(css).toContain('html[data-net-bar] .app-shell { padding-top: var(--net-bar-h); }');
        expect(css).toContain('html[data-net-bar] .app-sidebar--drawer { top: var(--net-bar-h); }');
        expect(layout).toMatch(/<NetworkBanner \/>\s*<AppShell/);
    });
});
