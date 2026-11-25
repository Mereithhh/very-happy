// @vitest-environment happy-dom
// B-976: the 「有 N 条更新说明」 bar goes into the first slot on screen — the sidebar, else under the session title bar.
import { describe, expect, it } from 'vitest';
import { pickChangelogHintSlot, type ChangelogHintSlotKind } from './changelogHintSlots';

const slots = (...kinds: ChangelogHintSlotKind[]) => new Map(kinds.map((k) => [k, k] as const));

describe('pickChangelogHintSlot', () => {
  it('desktop: the sidebar is on screen — the bar goes there', () => {
    expect(pickChangelogHintSlot(slots('session', 'sidebar'), () => true)?.kind).toBe('sidebar');
  });
  it('phone in a session (no sidebar on screen) or a folded sidebar: under the title bar', () => {
    expect(pickChangelogHintSlot(slots('session', 'sidebar'), (k) => k !== 'sidebar')?.kind).toBe('session');
  });
  it('no slot on screen: nowhere (it waits, never floats)', () => {
    expect(pickChangelogHintSlot(slots('sidebar'), () => false)).toBeNull();
    expect(pickChangelogHintSlot(slots(), () => true)).toBeNull();
  });
});
