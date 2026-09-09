// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { WorkspacePane } from './WorkspacePane';

it('restores nested scroll offsets after hiding and reordering without remounting content', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const render = (active: boolean, order: string) => root.render(<WorkspacePane active={active} order={order}><div data-scroll><input defaultValue="draft"/></div></WorkspacePane>);
  try {
    await act(async () => render(true,'a,b'));
    const scroll = host.querySelector<HTMLElement>('[data-scroll]')!;
    Object.defineProperty(scroll,'clientHeight',{value:200});
    scroll.scrollTop=230; scroll.scrollLeft=80;
    await act(async () => scroll.dispatchEvent(new Event('scroll')));
    await act(async () => render(false,'a,b'));
    scroll.scrollTop=0; scroll.scrollLeft=0;
    await act(async () => scroll.dispatchEvent(new Event('scroll')));
    await act(async () => render(true,'b,a'));
    expect(scroll.scrollTop).toBe(230); expect(scroll.scrollLeft).toBe(80);
    expect(host.querySelector('[data-scroll]')).toBe(scroll);
    expect(host.querySelector('input')?.value).toBe('draft');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
