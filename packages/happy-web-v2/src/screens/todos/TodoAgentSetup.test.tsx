// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lang: 'zh-Hans', server: 'https://self-hosted.example/happy', writeText: vi.fn() }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: mocks.lang }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => mocks.server }));
import { BUILTIN_TODO_SKILL } from '@slopus/happy-wire';
import { TodoAgentSetup } from './TodoAgentSetup';

let host: HTMLDivElement;
let root: Root;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.lang = 'zh-Hans';
    mocks.server = 'https://self-hosted.example/happy';
    mocks.writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.writeText } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
});
async function render() { await act(async () => root.render(<TodoAgentSetup />)); }
async function copy() { await act(async () => host.querySelector('button')!.click()); }

describe('official Todo skill handoff', () => {
    it('copies the full official skill with current service and account confirmation, without fetching a document', async () => {
        await render();
        expect(host.textContent).toContain('让 AI 使用我的待办');
        expect(host.querySelector('[role="status"]')!.textContent).toBe('');
        await copy();
        expect(mocks.writeText).toHaveBeenCalledOnce();
        const payload = mocks.writeText.mock.calls[0][0];
        expect(payload).toContain(BUILTIN_TODO_SKILL);
        expect(payload).toContain('期望服务端: https://self-hosted.example/happy');
        expect(payload).toContain('确认登录账号与网页当前账号一致');
        expect(host.querySelector('[role="status"]')!.textContent).toContain('已复制');
        expect(host.querySelector('a')).toBeNull();
    });

    it('waits for clipboard acknowledgement before success and prevents duplicate pending writes', async () => {
        let resolve!: () => void;
        mocks.writeText.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
        await render();
        await copy();
        expect(host.querySelector('button')!.disabled).toBe(true);
        expect(host.querySelector('[role="status"]')!.textContent).toBe('');
        await copy();
        expect(mocks.writeText).toHaveBeenCalledOnce();
        await act(async () => resolve());
        expect(host.querySelector('[role="status"]')!.textContent).toContain('已复制');
    });

    it('exposes identical read-only text on failure, retains retry, and clears failure after successful retry', async () => {
        mocks.writeText.mockRejectedValueOnce(new Error('Permission denied'));
        await render();
        await copy();
        expect(host.querySelector('[role="status"]')!.textContent).toBe('');
        expect(host.querySelector('[role="alert"]')!.textContent).toContain('复制失败');
        const preview = host.querySelector('textarea')!;
        expect(preview.readOnly).toBe(true);
        expect(preview.value).toBe(mocks.writeText.mock.calls[0][0]);
        expect(host.querySelector('button')!.disabled).toBe(false);
        await copy();
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.querySelector('[role="status"]')!.textContent).toContain('已复制');
    });

    it('offers manual copy when clipboard API is unavailable', async () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        await render();
        await copy();
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
        expect(host.querySelector('textarea')!.value).toContain(BUILTIN_TODO_SKILL);
        expect(host.querySelector('[role="status"]')!.textContent).toBe('');
    });

    it('supports English preview and removes credentials, query, and fragment from the service hint', async () => {
        mocks.lang = 'en';
        mocks.server = 'https://user:password@private.example/happy?token=secret#private';
        await render();
        expect(host.querySelector('button')!.textContent).toContain('Let AI use my todos');
        await act(async () => host.querySelectorAll('button')[1].click());
        expect(mocks.writeText).not.toHaveBeenCalled();
        const payload = host.querySelector('textarea')!.value;
        expect(payload).toContain('Expected server: https://private.example/happy');
        expect(payload).toContain('signed-in account matches');
        expect(payload).not.toContain('user:password');
        expect(payload).not.toContain('token=secret');
        expect(payload).not.toContain('#private');
        await copy();
        expect(host.querySelector('[role="status"]')!.textContent).toContain('Official skill copied');
    });
});
