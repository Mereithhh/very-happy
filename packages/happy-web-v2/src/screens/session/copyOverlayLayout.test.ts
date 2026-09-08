import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

const uiCss = readFileSync(new URL('../../ui/ui.css', import.meta.url), 'utf8');
let MessageView: typeof import('./MessageView').MessageView;
beforeAll(async () => {
  installBrowserTestGlobals();
  ({ MessageView } = await import('./MessageView'));
});

describe('message copy overlay layout', () => {
  it('keeps overlay buttons square instead of stretching between left and right offsets', () => {
    const overlay = uiCss.match(/\.vh-copy--overlay\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(overlay).toMatch(/width:\s*24px/);
    expect(overlay).toMatch(/height:\s*24px/);
    expect(overlay).toMatch(/justify-content:\s*center/);
  });

  it.each(['user-text', 'agent-text'] as const)('places %s actions after the body without a floating copy overlay', (kind) => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MessageView, {
      sessionId: 'copy-test', showMeta: false,
      message: { kind, id: 'message', localId: null, createdAt: 1, seq: 1, text: 'MESSAGE_BODY_SENTINEL' },
    })));
    expect(html.indexOf('class="msg-actions"')).toBeGreaterThan(html.indexOf('MESSAGE_BODY_SENTINEL'));
    expect(html).not.toContain('vh-copy--overlay');
    expect(html).toContain('role="group"');
  });
});
