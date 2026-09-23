import { beforeAll, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
let Notice: typeof import('./TerminalDirectShellNotice').TerminalDirectShellNotice;
let commands: typeof import('./TerminalDirectShellNotice').TMUX_INSTALL_COMMANDS;
beforeAll(async () => {
    installBrowserTestGlobals();
    const mod = await import('./TerminalDirectShellNotice');
    Notice = mod.TerminalDirectShellNotice;
    commands = mod.TMUX_INSTALL_COMMANDS;
});
it('B-486: tells the user how to install tmux, including a no-sudo path', () => {
    const html = renderToStaticMarkup(<Notice onDismiss={() => {}} />);
    for (const c of commands) expect(html).toContain(c.command);
    expect(commands.some((c) => !c.command.startsWith('sudo') && c.command.includes('conda'))).toBe(true);
    expect(html.match(/<button/g)).toHaveLength(1); // dismiss only — never blocks the terminal
});
it('B-486: both open paths (fresh + catch-up) latch the direct-shell state from the response', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('./WebTerminalScreen.tsx', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.match(/setDirectShell\(!tmuxAttached\);/g)).toHaveLength(2);
    expect(code).toMatch(/\{directShell && !directNoticeDismissed && <TerminalDirectShellNotice /);
});
