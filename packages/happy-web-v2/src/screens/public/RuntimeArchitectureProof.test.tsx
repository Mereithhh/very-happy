import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RuntimeArchitectureProof } from './RuntimeArchitectureProof';
import {
  getRuntimeArchitectureRoute,
  INITIAL_RUNTIME_ARCHITECTURE_STATE,
  runtimeArchitectureReducer,
} from './runtimeArchitectureModel';

describe('RuntimeArchitectureProof', () => {
  it('renders both shipped runtime paths without implying provider parity', () => {
    const html = renderToStaticMarkup(<RuntimeArchitectureProof />);

    expect(html).toContain('TWO EXECUTION PATHS // ONE WORKSPACE');
    expect(html).toContain('Managed Claude process');
    expect(html).toContain('Claude Agent SDK contract');
    expect(html).toContain('Real process inside tmux');
    expect(html).toContain('agent CLI · shell · editor · SSH');
    expect(html).toContain('native event → shared envelope');
    expect(html).toContain('pane output ⇄ input bytes');
    expect(html).toContain('OPTIONAL CLAUDE MIRROR');
    expect(html).toContain('Claude only');
    expect(html).toContain('≤ 8 MB · NO AUTO-RUN');
    expect(html).not.toContain('provider-neutral');
    expect(html).not.toContain('automatic routing');
  });

  it('starts with one explicitly selected path', () => {
    const html = renderToStaticMarkup(<RuntimeArchitectureProof />);
    const selected = html.match(/aria-pressed="true"/g) ?? [];

    expect(selected).toHaveLength(1);
    expect(html).toContain('Claude Agent SDK → normalized events → structured conversation');
  });

  it('switches the pure route model to the terminal source of truth', () => {
    const terminal = runtimeArchitectureReducer(INITIAL_RUNTIME_ARCHITECTURE_STATE, {
      type: 'select-path',
      path: 'terminal',
    });

    expect(terminal).toEqual({ activePath: 'terminal' });
    expect(getRuntimeArchitectureRoute(terminal)).toBe('tmux-owned process ⇄ control mode ⇄ xterm.js');
  });
});
