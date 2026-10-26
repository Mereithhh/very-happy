// @vitest-environment happy-dom
// B-823 (B-816 Q5): boot dialogs and invitations wait for the first screen.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAfterFirstScreen, markFirstScreenShown, resetAfterFirstScreenForTest, useAfterFirstScreen } from './afterFirstScreen';
import { dismissPrepaintSplash } from './prepaintSplash';
import { onChangelogOpenRequest, requestChangelogOpen, resetChangelogReadStoreForTest } from './changelogReadStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetAfterFirstScreenForTest();
  resetChangelogReadStoreForTest();
});

describe('B-823 afterFirstScreen', () => {
  it('settles only after the splash went AND the idle slot came', () => {
    const idle: Array<() => void> = [];
    resetAfterFirstScreenForTest((cb) => { idle.push(cb); });
    expect(isAfterFirstScreen()).toBe(false);
    const splash = { dataset: {} as DOMStringMap, style: { opacity: '' }, remove: vi.fn() };
    dismissPrepaintSplash({ getElementById: () => splash } as never, vi.fn(), '');
    expect(isAfterFirstScreen()).toBe(false);
    expect(idle).toHaveLength(1);
    idle[0]();
    expect(isAfterFirstScreen()).toBe(true);
    // Idempotent: a second dismiss schedules nothing more.
    markFirstScreenShown();
    expect(idle).toHaveLength(1);
  });

  it('no splash at all (already gone) still counts as shown', () => {
    const idle: Array<() => void> = [];
    resetAfterFirstScreenForTest((cb) => { idle.push(cb); });
    dismissPrepaintSplash({ getElementById: () => null } as never, vi.fn(), '');
    idle[0]();
    expect(isAfterFirstScreen()).toBe(true);
  });

  it('components using the hook mount their deferred part once it settles', () => {
    const idle: Array<() => void> = [];
    resetAfterFirstScreenForTest((cb) => { idle.push(cb); });
    const host = document.createElement('div');
    const root = createRoot(host);
    const Probe = () => (useAfterFirstScreen() ? createElement('span', null, 'late') : null);
    act(() => root.render(createElement(Probe)));
    expect(host.textContent).toBe('');
    act(() => { markFirstScreenShown(); idle[0](); });
    expect(host.textContent).toBe('late');
    act(() => root.unmount());
  });

  it('the sidebar entry\'s open request made before the deferred notice mounted is kept for it', () => {
    requestChangelogOpen();
    const listener = vi.fn();
    const off = onChangelogOpenRequest(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    requestChangelogOpen();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    const late = vi.fn();
    onChangelogOpenRequest(late)();
    expect(late).not.toHaveBeenCalled();
  });
});

describe('B-823 deferred mounts wiring', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

  it('release notes, install card, notification card and the update entry wait for the first screen', () => {
    const root = read('AppRoot.tsx');
    expect(root).toMatch(/function DeferredChangelogNotice\(\) \{\n  if \(!useAfterFirstScreen\(\)\) return null;/);
    expect(root).toMatch(/function DeferredPwaInstallPrompt\(\) \{\n  if \(!useAfterFirstScreen\(\)\) return null;/);
    // B-836: the feedback prompt card, too (lazy chunk, after the first screen).
    expect(root).toMatch(/function DeferredFeedbackPrompt\(\) \{\n  if \(!useAfterFirstScreen\(\)\) return null;/);
    // Both signed-in shells (deep link / home) mount the deferred notice, never the eager one.
    expect(root).toContain('return <><Outlet /><CliUpdateBanner /><MigrationBanner /><FirstMachineWelcome /><DeferredChangelogNotice /><DeferredFeedbackPrompt /><BundleUpdatedNotice />');
    expect(root).toContain('return <><AppLayout /><CliUpdateBanner /><MigrationBanner /><FirstMachineWelcome /><DeferredChangelogNotice /><DeferredFeedbackPrompt /><BundleUpdatedNotice />');
    expect(root).toContain('<DeferredPwaInstallPrompt />\n          <VhDiagGate />');
    expect(root).not.toMatch(/^import .*(ChangelogNotice|PwaInstallPrompt|FeedbackPrompt|LandingScreen|DocsScreen|PublicLegalScreen)'/m);
    expect(read('../screens/AppLayout.tsx')).toContain('{afterFirstScreen && <NotificationOptInCard />}');
    expect(read('DeferredMajorUpdateEntry.tsx')).toContain('if (!useAfterFirstScreen()) return null;');
    expect(read('../screens/sessions/Sidebar.tsx')).toContain('<DeferredMajorUpdateEntry />');
  });
});
