// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useRetainedWorkspace } from './useRetainedWorkspace';

it('keeps a collapsed workspace mounted and releases it on identity change', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const mounted = vi.fn(); const unmounted = vi.fn();
  function Content() {
    useEffect(() => { mounted(); return unmounted; }, []);
    return <input defaultValue="draft"/>;
  }
  function Fixture({ identity, open }: { identity: string; open: boolean }) {
    const value = useRetainedWorkspace(identity, open ? { tab: 'notes' } : null);
    return value && <aside key={identity} hidden={!open}><Content/></aside>;
  }
  const render = (identity: string, open: boolean) => act(async () => root.render(<Fixture identity={identity} open={open}/>));
  try {
    await render('a', false); expect(host.querySelector('input')).toBeNull();
    await render('a', true); const input = host.querySelector('input')!; input.value = 'unsaved local input';
    await render('a', false); expect(host.querySelector('aside')?.hidden).toBe(true);
    await render('a', true); expect(host.querySelector('input')).toBe(input); expect(input.value).toBe('unsaved local input');
    expect(mounted).toHaveBeenCalledTimes(1); expect(unmounted).not.toHaveBeenCalled();
    await render('b', false); expect(host.querySelector('aside')).toBeNull(); expect(unmounted).toHaveBeenCalledTimes(1);
    await render('b', true); expect(host.querySelector('input')?.value).toBe('draft'); expect(mounted).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
