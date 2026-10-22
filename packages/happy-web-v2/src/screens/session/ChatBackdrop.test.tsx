// @vitest-environment happy-dom
/**
 * B-752 — the chat backdrop's pacing wiring: paused while anything in the chat
 * body scrolls (capture listener, so the transcript's own scroller counts),
 * back to the preset after SCROLL_IDLE_MS, ≤ 8 fps while the agent works, and
 * nothing at all with 背景动效 off.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fieldProps = vi.hoisted(() => ({ calls: [] as { preset: string; pace: number | null | undefined }[] }));
const live = vi.hoisted(() => ({ session: { presence: 'online' as const, thinking: false } }));
vi.mock('@/ui/asciiField/AsciiField', () => ({
    AsciiField: (p: { preset: string; pace?: number | null }) => { fieldProps.calls.push({ preset: p.preset, pace: p.pace }); return <div data-ascii-field={p.preset} />; },
}));
vi.mock('@/sync/storage', () => ({ useSession: () => live.session }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => true }));

import { CHAT_COLUMN_PX, ChatBackdrop, MIN_SIDE_PX, SCROLL_IDLE_MS, backdropLayout } from './ChatBackdrop';
import { ASCII_MOTION_STORAGE, resetAsciiMotionForTests } from '@/ui/asciiField/asciiMotionPreference';
import { STREAMING_FPS } from '@/ui/asciiField/asciiFieldModel';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    resetAsciiMotionForTests();
    fieldProps.calls = [];
    live.session = { presence: 'online', thinking: false };
    host = document.createElement('div');
    host.className = 'sd-body';
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const lastPace = () => fieldProps.calls[fieldProps.calls.length - 1]?.pace;

describe('B-752 ChatBackdrop', () => {
    it('renders the calm chat preset behind the transcript, at the preset rate when idle', () => {
        act(() => root.render(<ChatBackdrop sessionId="s1" />));
        expect(host.querySelector('.sd-backdrop [data-ascii-field="chat"]')).not.toBeNull();
        expect(host.querySelector('.sd-backdrop')?.getAttribute('aria-hidden')).toBe('true');
        expect(lastPace()).toBeNull();
    });

    it('layout: two margin strips when both sides have room beside the 820px column, else one full field', () => {
        expect(CHAT_COLUMN_PX).toBe(820);
        expect(backdropLayout(CHAT_COLUMN_PX + 2 * MIN_SIDE_PX)).toBe('sides');
        expect(backdropLayout(1174)).toBe('sides');
        expect(backdropLayout(CHAT_COLUMN_PX + 2 * MIN_SIDE_PX - 1)).toBe('full');
        expect(backdropLayout(390)).toBe('full');
        // happy-dom reports width 0 → the narrow layout: a single field.
        act(() => root.render(<ChatBackdrop sessionId="s1" />));
        expect(host.querySelector('.sd-backdrop--full')).not.toBeNull();
        expect(host.querySelectorAll('[data-ascii-field="chat"]')).toHaveLength(1);
    });

    it('pauses while a scroller inside the chat body scrolls, resumes after the idle gap', () => {
        vi.useFakeTimers();
        act(() => root.render(<ChatBackdrop sessionId="s1" />));
        const scroller = document.createElement('div');
        host.append(scroller);
        act(() => { scroller.dispatchEvent(new Event('scroll')); });
        expect(lastPace()).toBe(0);
        act(() => { vi.advanceTimersByTime(SCROLL_IDLE_MS - 100); scroller.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(SCROLL_IDLE_MS - 100); });
        expect(lastPace()).toBe(0);
        act(() => { vi.advanceTimersByTime(200); });
        expect(lastPace()).toBeNull();
    });

    it('drops to the streaming rate while the agent works', () => {
        live.session = { presence: 'online', thinking: true };
        act(() => root.render(<ChatBackdrop sessionId="s1" />));
        expect(lastPace()).toBe(STREAMING_FPS);
    });

    it('背景动效 off: renders nothing', () => {
        localStorage.setItem(ASCII_MOTION_STORAGE, 'off');
        resetAsciiMotionForTests();
        act(() => root.render(<ChatBackdrop sessionId="s1" />));
        expect(host.querySelector('.sd-backdrop')).toBeNull();
        expect(fieldProps.calls).toHaveLength(0);
    });
});
