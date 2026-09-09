// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { highlightToHtml } from './highlighter';
import { CommandView } from './CommandView';

vi.mock('@/ui/CopyButton', () => ({ CopyButton: () => null }));

it('highlights shell syntax without changing or interpreting the command text', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const command = 'echo "<img src=x onerror=alert(1)>" && pnpm test --filter "chat"';
    try {
        await act(async () => { root.render(<CommandView command={command} stdout="48 passed" />); });
        await act(async () => { await highlightToHtml(command, 'bash'); });
        expect(host.querySelector('.cmd-highlight span')).not.toBeNull();
        expect(host.querySelector('.cmd-cmd')?.textContent).toBe(command);
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('.cmd-stream')?.textContent).toBe('48 passed');
        await act(async () => { root.render(<CommandView command="echo changed" />); });
        expect(host.querySelector('.cmd-cmd')?.textContent).toBe('echo changed');
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
