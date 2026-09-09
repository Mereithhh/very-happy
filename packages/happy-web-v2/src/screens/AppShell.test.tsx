// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppShell, type AppShellMode } from './AppShell';

it('preserves the view, unsaved inputs and singleton notes through resize and sidebar collapse', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const viewUnmounted = vi.fn();
  const notesMounted = vi.fn();
  function View() {
    useEffect(() => () => viewUnmounted(), []);
    return <textarea defaultValue="original" />;
  }
  function Notes() {
    useEffect(() => { notesMounted(); }, []);
    return <aside data-notes><input defaultValue="note" /></aside>;
  }
  const render = (mode: AppShellMode) => act(async () => root.render(
    <AppShell mode={mode} width={260} sidebar={<nav>Sessions</nav>} rail={<button>Expand</button>} notes={<Notes />} onResizeStart={vi.fn()}>
      <View />
    </AppShell>,
  ));
  try {
    await render('expanded');
    const input = host.querySelector('textarea')!;
    const notes = host.querySelector('[data-notes]')!;
    input.value = 'not saved yet';
    for (const mode of ['collapsed', 'single', 'expanded', 'single'] as const) {
      await render(mode);
      expect(host.querySelector('textarea')).toBe(input);
      expect(input.value).toBe('not saved yet');
      expect(host.querySelector('[data-notes]')).toBe(notes);
      expect(host.querySelectorAll('[data-notes]')).toHaveLength(1);
    }
    expect(viewUnmounted).not.toHaveBeenCalled();
    await render('list');
    expect(host.querySelector('main')).toBeNull();
    expect(host.querySelector('.app-sidebar--full nav')?.textContent).toBe('Sessions');
    expect(viewUnmounted).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-notes]')).toBe(notes);
    expect(notesMounted).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
