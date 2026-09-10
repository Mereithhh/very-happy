import { beforeAll, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
let Notice: typeof import('./TerminalConnectionNotice').TerminalConnectionNotice;
beforeAll(async () => {
    installBrowserTestGlobals();
    Notice = (await import('./TerminalConnectionNotice')).TerminalConnectionNotice;
});
const props = { machineName: 'dsw-test', compact: false, canRetry: true, onRetry: () => {}, onMachine: () => {} };
it('renders an accessible loading indicator and target identity', () => {
    const html = renderToStaticMarkup(<Notice {...props} state="connecting" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('term-connection-loading');
    expect(html).toContain('dsw-test');
    expect(html).not.toContain('<button');
});
it('shows offline recovery without an endless spinner', () => {
    const html = renderToStaticMarkup(<Notice {...props} state="offline" />);
    expect(html).not.toContain('term-connection-spinner');
    expect(html.match(/<button/g)).toHaveLength(1);
});
it('does not offer a retry for an uncertain fresh creation', () => {
    const safe = renderToStaticMarkup(<Notice {...props} state="failed" />);
    const uncertain = renderToStaticMarkup(<Notice {...props} state="failed" canRetry={false} />);
    expect(safe.match(/<button/g)).toHaveLength(2);
    expect(uncertain.match(/<button/g)).toHaveLength(1);
    expect(uncertain).not.toEqual(safe);
});
it('removes the notice after connecting', () => {
    expect(renderToStaticMarkup(<Notice {...props} state={null} />)).toBe('');
});
