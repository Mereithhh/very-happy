// @vitest-environment happy-dom
/**
 * B-923 QA P1: the composer draft survives the column unmounting (⌘⇧E close,
 * a window narrowed below the dock threshold) and moving to the /main-agent
 * page — it lives in the main agent store, not in component state.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { MainAgentState } from '@/assistant/mainAgent';

vi.mock('@/sync/storage', () => ({
    useSession: () => ({ id: 's1', thinking: false, agentState: null }),
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
    useLocalSetting: () => null,
}));
vi.mock('@/sync/sync', () => ({ sync: { onSessionEnter: vi.fn(), sendMessage: vi.fn() } }));
vi.mock('@/screens/session/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/assistant/useMainAgent', () => ({ useMainAgentActions: () => ({ spawning: false, spawnError: null, enable: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));

let MainAgentPanel: typeof import('./MainAgentPanel').MainAgentPanel;
let store: typeof import('@/assistant/mainAgentStore').useMainAgentStore;
beforeAll(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    ({ MainAgentPanel } = await import('./MainAgentPanel'));
    ({ useMainAgentStore: store } = await import('@/assistant/mainAgentStore'));
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    host = null; root = null;
});

const ready = { kind: 'ready', session: { id: 's1', metadata: { capabilities: ['main-agent-gates-v1'] } }, machine: { id: 'm1', metadata: { host: 'box' } }, offline: false } as unknown as MainAgentState;

async function mount(variant: 'dock' | 'page') {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<MemoryRouter><MainAgentPanel state={ready} variant={variant} onClose={() => {}} /></MemoryRouter>));
    return host.querySelector<HTMLTextAreaElement>('.ma-input')!;
}
async function unmount() {
    await act(async () => root!.unmount());
    host!.remove(); root = null; host = null;
}

it('keeps the unsent draft across unmount / remount and between the column and the page', async () => {
    let input = await mount('dock');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, 'half-written question');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(store.getState().composerDraft).toBe('half-written question');
    await unmount(); // ⌘⇧E closes the column / the window got too narrow
    input = await mount('dock');
    expect(input.value).toBe('half-written question');
    await unmount();
    input = await mount('page'); // the same draft on the full-screen page
    expect(input.value).toBe('half-written question');
});
