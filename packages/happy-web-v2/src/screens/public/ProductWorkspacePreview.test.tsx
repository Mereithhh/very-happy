import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProductWorkspacePreview } from './ProductWorkspacePreview';

describe('ProductWorkspacePreview', () => {
  it('names and renders the initial multi-machine command panel truthfully', () => {
    const html = renderToStaticMarkup(<ProductWorkspacePreview compact initialWorkspaceNavOpen />);

    expect(html).toContain('aria-label="Interactive sanitized multi-machine session command panel"');
    expect(html).toContain('Showing the sanitized multi-machine session command panel.');
    expect(html).toContain('build · terminal');
    expect(html).toContain('office · codex · ~/very-happy');
    expect(html).toContain('stage · claude · ~/very-happy');
    expect(html).not.toContain('build · claude · working');
  });

  it('names a detail-first preview by the visible product surface', () => {
    const html = renderToStaticMarkup(<ProductWorkspacePreview compact initialView="terminal" />);

    expect(html).toContain('aria-label="Interactive sanitized terminal and files product preview"');
    expect(html).toContain('Showing the sanitized terminal and files product preview.');
  });
});
