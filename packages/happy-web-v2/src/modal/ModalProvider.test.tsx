// @vitest-environment happy-dom
// B-830: while the sign-in expiry dialog (a `critical` overlay) is up, a
// pending Modal.confirm waits hidden — it neither draws over the page nor
// takes Esc / Enter meant for the expiry dialog — and comes back afterwards.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_PRIORITY, requestOverlay, resetOverlayQueueForTest } from '@/app/overlayQueue';

vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./modal.css', () => ({}));

import { ModalProvider } from './ModalProvider';
import { Modal } from './ModalManager';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetOverlayQueueForTest(); });

const card = () => host.querySelector('.vh-modal-card');
const press = (key: string) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });

describe('ModalProvider under a critical overlay (B-830)', () => {
    it('a pending confirm hides and ignores Esc / Enter while the expiry dialog is up, then returns', async () => {
        await act(async () => root.render(<ModalProvider><span /></ModalProvider>));
        let answer: boolean | undefined;
        await act(async () => { void Modal.confirm('Keep going?').then((v) => { answer = v; }); });
        expect(card()).not.toBeNull();

        let release = () => {};
        await act(async () => { release = requestOverlay('auth', OVERLAY_PRIORITY.critical); });
        expect(card()).toBeNull();
        await press('Enter');
        await press('Escape');
        expect(answer).toBeUndefined();

        await act(async () => release());
        expect(card()).not.toBeNull();
        await press('Escape');
        expect(answer).toBe(false);
    });
});
