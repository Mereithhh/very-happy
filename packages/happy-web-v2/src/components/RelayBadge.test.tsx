// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RelayBadge } from './RelayBadge';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://veryhappy.dev' }));

it('reveals relay facts on hover and tap, and does not report stale regional RTT during fallback', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<RelayBadge status={{ transport: 'regional', state: 'connected', region: 'US West', rttMs: 128 }} />));
        const trigger = host.querySelector('button')!;
        expect(trigger.querySelector('.relay-badge-region')?.textContent).toBe('US WEST');
        expect(trigger.querySelector('.relay-badge-flag')?.getAttribute('aria-hidden')).toBe('true');
        expect(trigger.getAttribute('aria-label')).toContain('US WEST');
        await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); });
        expect(document.querySelector('.relay-detail')?.textContent).toContain('128 ms');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' })); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 170)); });
        expect(document.querySelector('.relay-detail')).toBeNull();
        await act(async () => root.render(<RelayBadge status={{ transport: 'legacy', state: 'fallback', region: 'US West', rttMs: 128 }} />));
        await act(async () => trigger.click());
        expect(trigger.textContent).toContain('SG');
        expect(trigger.querySelector('.relay-badge-region')?.textContent).toBe('SG');
        expect(document.querySelector('.relay-detail')?.textContent).toContain('relayBadge.control');
        expect(document.querySelector('.relay-detail')?.textContent).not.toContain('128 ms');
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('keeps custom regional names intact without relying on a country flag', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<RelayBadge status={{ transport: 'regional', state: 'connected', region: 'Frankfurt Private Relay' }} />));
        const trigger = host.querySelector('button')!;
        expect(trigger.querySelector('.relay-badge-region')?.textContent).toBe('FRANKFURT PRIVATE RELAY');
        expect(trigger.querySelector('.relay-badge-flag')).toBeNull();
        expect(trigger.getAttribute('aria-label')).toContain('FRANKFURT PRIVATE RELAY');
        await act(async () => trigger.click());
        expect(document.querySelector('.relay-detail')?.textContent).toContain('Frankfurt Private Relay');
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
