/**
 * B-508 source assertions (verified with scripts/dev/mutation-check.mjs):
 * the band must not shrink inside the automations page's flex column (it
 * clipped to its first row on /automations), every row carries the round
 * 「知道了」 check, the session page mounts the decision strip and the sidebar
 * row carries the marker.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const block = (css: string, selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
};

describe('B-508 attention band and session strip wiring', () => {
  it('the band is a non-shrinking flex child and the board scrolls its list instead of losing the lanes', () => {
    const css = read('./automations.css');
    expect(block(css, '.au-attn')).toContain('flex-shrink: 0;');
    expect(block(css, '.au-attn-row')).toContain("grid-template-areas: 'check main actions';");
    expect(css).toContain('.au-attn-check {\n    width: 44px;\n    height: 44px;\n  }');
    const board = read('../board/board.css');
    expect(block(board, '.bd-attn-wrap > .au-attn .au-attn-list')).toContain('max-height: 40vh;');
  });
  it('every row has the round check as its acknowledge and the header offers acknowledge-all', () => {
    const src = read('./AttentionSection.tsx');
    expect(src).toContain('className="au-attn-check"');
    expect(src).toContain("await ack(run.id, 'owner');");
    expect(src).toContain('const n = await ackAll();');
  });
  it('the session page mounts the strip per visit and the sidebar row gets the marker', () => {
    const detail = read('../session/SessionDetailScreen.tsx');
    expect(detail).toContain('{!mirror && <AutomationAttentionBanner key={id} sessionId={id} />}');
    const banner = read('../session/AutomationAttentionBanner.tsx');
    expect(banner).toContain("for (const id of replied) await ack(id, 'owner-replied').catch(() => undefined);");
    const sidebar = read('../sessions/Sidebar.tsx');
    expect(sidebar).toContain("automationAttention={r.kind === 'session' && automationAttentionKeys.has(r.key)}");
    expect(sidebar).toContain('className="sb-row-auto-attn"');
  });
});
