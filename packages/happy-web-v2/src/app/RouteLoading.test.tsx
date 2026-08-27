import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RouteLoading } from './RouteLoading';

describe('RouteLoading', () => {
  it('fills the viewport for chromeless full-screen routes', () => {
    const html = renderToStaticMarkup(<RouteLoading fullViewport />);

    expect(html).toContain('height:100dvh');
    expect(html).toContain('width:100vw');
    expect(html).toContain('position:fixed');
    expect(html).toContain('inset:0');
    expect(html).toContain('align-items:center');
    expect(html).toContain('justify-content:center');
    expect(html).toContain('aria-label="Loading workspace"');
    expect(html).toContain('vh-orbit-widget--medium');
    expect(html).toContain('vh-orbit-widget__wordmark');
  });

  it('keeps the parent-flex sizing used by regular app routes', () => {
    const html = renderToStaticMarkup(<RouteLoading />);

    expect(html).not.toContain('height:100dvh');
    expect(html).not.toContain('position:fixed');
    expect(html).toContain('width:100%');
    expect(html).toContain('flex:1');
  });

  it('accepts a localized loading label', () => {
    const html = renderToStaticMarkup(<RouteLoading label="加载中..." />);
    expect(html).toContain('aria-label="加载中..."');
  });

  it('matches the HTML pre-paint loader geometry during the cold-start handoff', () => {
    const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const orbitCss = readFileSync(new URL('../ui/orbitLoader.css', import.meta.url), 'utf8');

    expect(indexHtml).toMatch(/\.vh-orbit-viewport\s*\{[^}]*width:\s*234px;[^}]*height:\s*234px;/s);
    expect(indexHtml).toMatch(/\.vh-orbit-stage\s*\{[^}]*width:\s*324px;[^}]*height:\s*324px;[^}]*scale\(0\.72\)/s);
    expect(orbitCss).toMatch(/\.vh-orbit-widget--medium\s*\{[^}]*--vh-orbit-scale:\s*0\.72;[^}]*--vh-orbit-viewport:\s*234px;/s);
    expect(indexHtml).toContain('class="vh-orbit-viewport"');
    expect(indexHtml).not.toContain('.vh-orbit-loader { transform: scale(0.86); }');
  });
});
