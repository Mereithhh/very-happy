// @vitest-environment happy-dom
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({ Spinner: () => null }));
vi.mock('@/ui/CopyButton', () => ({ CopyButton: () => null }));
vi.mock('../session/CodeView', () => ({ CodeView: ({ code }: { code: string }) => <pre data-code="1">{code}</pre> }));
vi.mock('../session/Markdown', () => ({ Markdown: () => null }));
vi.mock('./SpreadsheetPreview', () => ({ SpreadsheetPreview: () => null }));

// A tiny external store standing in for the session's messages.
const bus = vi.hoisted(() => {
    let messages: unknown[] = [];
    const listeners = new Set<() => void>();
    return {
        get: () => messages,
        set: (next: unknown[]) => { messages = next; listeners.forEach((l) => l()); },
        subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
    };
});
vi.mock('@/sync/storage', () => ({
    useMachine: () => null,
    useSession: () => ({ metadata: { path: '/repo' } }),
    useSessionMessages: () => ({ messages: useSyncExternalStore(bus.subscribe, bus.get) }),
}));
const fs = vi.hoisted(() => ({ content: 'v1', reads: 0 }));
vi.mock('@/sync/fsOps', () => ({
    machineFsRead: vi.fn(async () => {
        fs.reads++;
        return { ok: true, binary: false, content: Buffer.from(fs.content).toString('base64'), size: fs.content.length, truncated: false };
    }),
}));

import { FsFileViewer } from './FsFileViewer';

const write = (id: string, completedAt: number): Message => ({
    kind: 'tool-call', id, localId: null, createdAt: completedAt - 1, children: [],
    tool: { name: 'Edit', state: 'completed', input: { file_path: 'src/a.ts', old_string: 'v1', new_string: 'v2' }, createdAt: completedAt - 1, startedAt: null, completedAt, description: null },
});

let T0 = 0;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    fs.content = 'v1'; fs.reads = 0; T0 = Date.now(); bus.set([write('old', T0 - 60_000)]);
    // jsdom has no layout: treat the viewer as visible
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
});
const props = { sessionId: 's1', machineId: 'm', path: '/repo/src/a.ts', onClose: () => {}, fullscreen: false, onToggleFullscreen: () => {} };
const code = () => host.querySelector('[data-code]')?.textContent;

it('an agent write to the open file refreshes it silently, keeping the scroll position', async () => {
    await act(async () => root.render(<FsFileViewer {...props} />));
    expect(code()).toBe('v1');
    expect(fs.reads).toBe(1);                      // edits that predate opening do not reload
    const body = host.querySelector<HTMLElement>('.fsb-viewer-body')!;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 100 });
    body.scrollTop = 240;
    fs.content = 'v2';
    await act(async () => bus.set([write('old', T0 - 60_000), write('new', T0 + 5_000)]));
    expect(fs.reads).toBe(2);
    expect(code()).toBe('v2');
    expect(host.querySelector('.fsb-agent-changed')).toBeNull();
    expect(host.querySelector<HTMLElement>('.fsb-viewer-body')!.scrollTop).toBe(240);
});

it('a write while text is selected in the viewer shows the banner instead; 刷新 re-reads', async () => {
    await act(async () => root.render(<FsFileViewer {...props} />));
    const range = document.createRange();
    range.selectNodeContents(host.querySelector('[data-code]')!);
    window.getSelection()!.addRange(range);
    fs.content = 'v2';
    await act(async () => bus.set([write('old', T0 - 60_000), write('new', T0 + 5_000)]));
    expect(fs.reads).toBe(1);
    expect(code()).toBe('v1');
    expect(host.querySelector('.fsb-agent-changed')?.textContent).toContain('The agent changed this file');
    await act(async () => host.querySelector<HTMLButtonElement>('.fsb-agent-changed-refresh')!.click());
    expect(fs.reads).toBe(2);
    expect(code()).toBe('v2');
    expect(host.querySelector('.fsb-agent-changed')).toBeNull();
});

it('writes to other files, and viewers without a session, never reload', async () => {
    await act(async () => root.render(<FsFileViewer {...props} path="/repo/src/b.ts" />));
    await act(async () => bus.set([write('old', T0 - 60_000), write('new', T0 + 5_000)]));
    expect(fs.reads).toBe(1);
    await act(async () => root.render(<FsFileViewer {...props} sessionId={undefined} />));
    const before = fs.reads;
    await act(async () => bus.set([write('old', T0 - 60_000), write('new', T0 + 5_000), write('newer', T0 + 9_000)]));
    expect(fs.reads).toBe(before);
});

it('history loaded after opening (older writes) and the first message load never reload the file (review 中2)', async () => {
    bus.set([]);
    await act(async () => root.render(<FsFileViewer {...props} />));
    // first load of the transcript brings a write from before the file was read
    await act(async () => bus.set([write('before-open', T0 - 1_000)]));
    // an older page arrives later
    await act(async () => bus.set([write('before-open', T0 - 1_000), write('older-page', T0 - 90_000)]));
    expect(fs.reads).toBe(1);
    expect(host.querySelector('.fsb-agent-changed')).toBeNull();
});

it('a streaming burst of writes within a second is merged into one trailing refresh (review 低3)', async () => {
    await act(async () => root.render(<FsFileViewer {...props} />));
    fs.content = 'v2';
    await act(async () => bus.set([write('old', T0 - 60_000), write('w1', T0 + 1_000)]));
    expect(fs.reads).toBe(2);                       // first change after a quiet second: immediate
    fs.content = 'v3';
    await act(async () => bus.set([write('old', T0 - 60_000), write('w1', T0 + 1_000), write('w2', T0 + 2_000)]));
    await act(async () => bus.set([write('old', T0 - 60_000), write('w1', T0 + 1_000), write('w2', T0 + 2_000), write('w3', T0 + 3_000)]));
    expect(fs.reads).toBe(2);                       // held back…
    await act(async () => { await new Promise((r) => setTimeout(r, 1_100)); });
    expect(fs.reads).toBe(3);                       // …and merged into ONE re-read
    expect(code()).toBe('v3');
});
