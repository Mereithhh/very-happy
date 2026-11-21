import { beforeAll, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
let Notice: typeof import('./TerminalConnectionNotice').TerminalConnectionNotice;
let View: typeof import('./TerminalConnectionNotice').TerminalNoticeView;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ TerminalConnectionNotice: Notice, TerminalNoticeView: View } = await import('./TerminalConnectionNotice'));
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
it('B-943: the shared-terminal notice names the machine and offers its action only when not waiting', () => {
    const offline = renderToStaticMarkup(<View waiting={false} compact={false} title="This machine isn't connected" machine="Alex's mac-studio" detail="comes back by itself" actions={<button type="button">Retry now</button>} />);
    expect(offline).toContain('role="status"');
    expect(offline).toContain('mac-studio');
    expect(offline.match(/<button/g)).toHaveLength(1);
    const waiting = renderToStaticMarkup(<View waiting compact={false} title="Connecting" machine="Alex's mac-studio" detail="waiting" actions={<button type="button">Retry now</button>} />);
    expect(waiting).toContain('term-connection-loading');
    expect(waiting).not.toContain('<button');
});
it('B-950: over a painted terminal the notice is one row (title · machine + actions + fold), the explanation kept for screen readers', () => {
    const html = renderToStaticMarkup(<View waiting={false} compact title="This machine isn't connected" machine="Alex's mac-studio" detail="comes back by itself" actions={<button type="button">Retry now</button>} />);
    expect(html).toContain('is-compact');
    expect(html).not.toContain('<p>');
    expect(html).toContain('term-connection-detail');
    expect(html).toContain('title="comes back by itself"');
    expect(html).toContain('term-connection-fold');
    expect(html.match(/<button/g)).toHaveLength(2);
    // The full-pane notice (nothing painted yet) keeps its paragraph and has no fold.
    const full = renderToStaticMarkup(<View waiting={false} compact={false} title="t" machine="m" detail="d" actions={<button type="button">Retry now</button>} />);
    expect(full).toContain('<p>d</p>');
    expect(full).not.toContain('term-connection-fold');
});
