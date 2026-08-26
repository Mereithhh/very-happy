import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RouteLoading } from './RouteLoading';

describe('RouteLoading', () => {
  it('fills the viewport for chromeless full-screen routes', () => {
    const html = renderToStaticMarkup(<RouteLoading fullViewport />);

    expect(html).toContain('height:100dvh');
    expect(html).toContain('width:100%');
    expect(html).toContain('align-items:center');
    expect(html).toContain('justify-content:center');
    expect(html).toContain('aria-label="Loading workspace"');
  });

  it('keeps the parent-flex sizing used by regular app routes', () => {
    const html = renderToStaticMarkup(<RouteLoading />);

    expect(html).not.toContain('height:100dvh');
    expect(html).toContain('flex:1');
  });
});
