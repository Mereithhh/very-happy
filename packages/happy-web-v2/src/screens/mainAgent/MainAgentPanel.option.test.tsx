// @vitest-environment happy-dom
/**
 * B-924d (QA-T P1-2): a suggestion chip (`<options>`) under a main agent reply is the agent's text — the click
 * goes out with an `option-` localId (the CLI reads it as board_choice: nothing unlocked). Typing stays the owner's.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { isOwnerTypedMessage } from '@slopus/happy-wire';
import type { MainAgentState } from '@/assistant/mainAgent';

const mock = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('@/sync/storage', () => ({
    useSession: () => ({ id: 's1', thinking: false, agentState: null }),
    useSessionMessages: () => ({ messages: [{ kind: 'agent-text', id: 'a1', text: '要交给 t5 吗？' }], isLoaded: true }),
    useLocalSetting: () => null,
}));
vi.mock('@/sync/sync', () => ({ sync: { onSessionEnter: vi.fn(), sendMessage: mock.sendMessage } }));
// the chip renderer: one button that calls onOption with the agent's text
vi.mock('@/screens/session/Markdown', () => ({
    Markdown: ({ onOption }: { onOption?: (o: string) => void }) => onOption ? <button className="chip" onClick={() => onOption('交给 t5 整理构建日志')}>chip</button> : null,
}));
vi.mock('@/assistant/useMainAgent', () => ({ useMainAgentActions: () => ({ spawning: false, spawnError: null, enable: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));

let MainAgentPanel: typeof import('./MainAgentPanel').MainAgentPanel;
beforeAll(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    ({ MainAgentPanel } = await import('./MainAgentPanel'));
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove(); host = null; root = null;
});
const ready = { kind: 'ready', session: { id: 's1', metadata: { capabilities: ['main-agent-gates-v1'] } }, machine: { id: 'm1', metadata: { host: 'box' } }, offline: false } as unknown as MainAgentState;

it('a chip click sends with an option- localId; the composer sends with an ordinary one', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<MemoryRouter><MainAgentPanel state={ready} variant="dock" onClose={() => {}} /></MemoryRouter>));
    const chip = host.querySelector<HTMLButtonElement>('.chip');
    expect(chip).not.toBeNull();
    await act(async () => { chip!.click(); });
    expect(mock.sendMessage).toHaveBeenCalledOnce();
    const [sid, text, opts] = mock.sendMessage.mock.calls[0];
    expect([sid, text]).toEqual(['s1', '交给 t5 整理构建日志']);
    expect(opts.localId).toMatch(/^option-/);
    expect(isOwnerTypedMessage(opts.localId, 'web')).toBe(false);
});
