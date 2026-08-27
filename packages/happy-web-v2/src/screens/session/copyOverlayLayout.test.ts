import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const uiCss = readFileSync(new URL('../../ui/ui.css', import.meta.url), 'utf8');
const messageCss = readFileSync(new URL('./message.css', import.meta.url), 'utf8');

describe('message copy overlay layout', () => {
  it('keeps overlay buttons square instead of stretching between left and right offsets', () => {
    const overlay = uiCss.match(/\.vh-copy--overlay\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(overlay).toMatch(/width:\s*24px/);
    expect(overlay).toMatch(/height:\s*24px/);
    expect(overlay).toMatch(/justify-content:\s*center/);
  });

  it('uses selectors specific enough to override the base overlay position', () => {
    const userOverlay = messageCss.match(/\.vh-copy--overlay\.msg-copy--user\s*\{([^}]*)\}/)?.[1] ?? '';
    const agentOverlay = messageCss.match(/\.vh-copy--overlay\.msg-copy--agent\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(userOverlay).toMatch(/right:\s*auto/);
    expect(userOverlay).toMatch(/left:\s*-34px/);
    expect(agentOverlay).toMatch(/right:\s*0/);
  });
});
