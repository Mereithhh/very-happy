// @vitest-environment happy-dom
/** B-643: switching the in-app theme retints the iOS status bar (theme-color) live. */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('setPreference rewrites every theme-color meta to that theme’s bg-0', async () => {
  document.head.innerHTML = '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#151515">'
    + '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fcfcfb">'
    + '<meta name="theme-color" content="#151515">';
  const contents = () => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'));
  let set: (p: 'light' | 'dark' | 'system') => void = () => {};
  function Probe() { set = useTheme().setPreference; return null; }
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => { root.render(<ThemeProvider><Probe /></ThemeProvider>); });
  await act(async () => { set('light'); });
  expect(contents()).toEqual(['#fcfcfb', '#fcfcfb', '#fcfcfb']);
  await act(async () => { set('system'); });
  expect(contents()).toEqual(['#151515', '#fcfcfb', '#151515']);
  root.unmount();
});
