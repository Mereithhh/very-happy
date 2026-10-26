// @vitest-environment happy-dom
// B-823 (QA9 O-2): the cold-start commit carries the composer, not the transcript.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { splashStillUp, useAfterSplashPaint } from './afterSplashPaint';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { document.getElementById('vh-splash')?.remove(); });

function mount(schedule: (fire: () => void) => () => void) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const Screen = () => createElement('div', null, createElement('textarea', { className: 'ci-textarea' }), useAfterSplashPaint(schedule) ? createElement('ul', null, 'transcript') : null);
  act(() => root.render(createElement(Screen)));
  return { host, root };
}

describe('B-823 useAfterSplashPaint', () => {
  it('under the splash: the first commit has the composer only; the transcript follows after the paint', () => {
    const splash = document.createElement('div');
    splash.id = 'vh-splash';
    document.body.append(splash);
    const fires: Array<() => void> = [];
    const { host, root } = mount((fire) => { fires.push(fire); return () => {}; });
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.textContent).not.toContain('transcript');
    expect(fires).toHaveLength(1);
    act(() => fires[0]());
    expect(host.textContent).toContain('transcript');
    act(() => root.unmount());
  });

  it('without the splash (any later mount, a session switch) it renders everything at once', () => {
    const fires: Array<() => void> = [];
    const { host, root } = mount((fire) => { fires.push(fire); return () => {}; });
    expect(host.textContent).toContain('transcript');
    expect(fires).toHaveLength(0);
    act(() => root.unmount());
  });

  it('a fading splash no longer counts', () => {
    const splash = document.createElement('div');
    splash.id = 'vh-splash';
    splash.dataset.dismissing = 'true';
    document.body.append(splash);
    expect(splashStillUp()).toBe(false);
    splash.dataset.dismissing = '';
    expect(splashStillUp()).toBe(true);
  });

  it('the session screen gates its transcript on it', () => {
    const screen = readFileSync(resolve(__dirname, '../screens/session/SessionDetailScreen.tsx'), 'utf8');
    expect(screen).toContain('const transcriptNow = useAfterSplashPaint();');
    expect(screen).toContain('(transcriptNow ? <ChatList key={id} sessionId={id} showLiveStatus={!mirror} /> : <ColdTranscriptPlaceholder />)');
  });
});
