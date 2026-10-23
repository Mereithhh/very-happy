import { describe, expect, it } from 'vitest';
import { FEATURE_TIPS, FEATURE_TIPS_SEEN_STORAGE, pickTip, placeTip, peekShortcutLabel, readSeen, tipTextKey, tipToken, writeSeen, type FeatureTipId } from './featureTipsModel';

function memStore(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(FEATURE_TIPS_SEEN_STORAGE, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('feature tips (B-588)', () => {
  it('versioned key uses the _STORAGE naming and an @version token', () => {
    expect(FEATURE_TIPS_SEEN_STORAGE).toBe('vh.featureTips.seen.v1');
    expect(tipToken({ id: 'review-all', version: 2 })).toBe('review-all@2');
  });

  it('round-trips the seen set; garbage or throwing storage reads as empty', () => {
    const store = memStore();
    writeSeen(store, new Set(['review-all@1']));
    expect(readSeen(store)).toEqual(new Set(['review-all@1']));
    expect(readSeen(memStore('{nope'))).toEqual(new Set());
    expect(readSeen(memStore('[1, "x@1"]'))).toEqual(new Set(['x@1']));
    const throwing = { getItem: () => { throw new Error('denied'); } };
    expect(readSeen(throwing)).toEqual(new Set());
    expect(() => writeSeen({ setItem: () => { throw new Error('quota'); }, removeItem: () => {} }, new Set(['a@1']))).not.toThrow();
    writeSeen(store, new Set());
    expect(store.data.has(FEATURE_TIPS_SEEN_STORAGE)).toBe(false);
  });

  it('picks the first unseen tip in order that has a visible anchor; a bumped version shows again', () => {
    expect(FEATURE_TIPS.map((d) => d.id)).toEqual(['quick-open', 'prompt-rail', 'review-all', 'session-peek']);
    const visible = new Set<FeatureTipId>(['prompt-rail', 'session-peek']);
    expect(pickTip(FEATURE_TIPS, new Set(), visible)?.id).toBe('prompt-rail');
    expect(pickTip(FEATURE_TIPS, new Set(['prompt-rail@1']), visible)?.id).toBe('session-peek');
    expect(pickTip(FEATURE_TIPS, new Set(['prompt-rail@1', 'session-peek@1']), visible)).toBeNull();
    expect(pickTip([{ id: 'session-peek', version: 2 }], new Set(['session-peek@1']), visible)?.id).toBe('session-peek');
    expect(pickTip(FEATURE_TIPS, new Set(), new Set())).toBeNull();
  });

  it('copy follows the entry form: phone prompt nav vs rail, touch preview via the menu', () => {
    expect(tipTextKey('prompt-rail', { coarse: false, compactNav: false })).toBe('featureTips.promptRail');
    expect(tipTextKey('prompt-rail', { coarse: true, compactNav: true })).toBe('featureTips.promptNav');
    expect(tipTextKey('session-peek', { coarse: true, compactNav: false })).toBe('featureTips.sessionPeekMenu');
    expect(tipTextKey('session-peek', { coarse: false, compactNav: false })).toBe('featureTips.sessionPeekHover');
    expect(tipTextKey('quick-open', { coarse: false, compactNav: false })).toBe('featureTips.quickOpen');
  });

  it('writes the preview shortcut the way the platform does', () => {
    expect(peekShortcutLabel(true)).toBe('⌥↩');
    expect(peekShortcutLabel(false)).toBe('Alt+Enter');
  });

  describe('placeTip', () => {
    const viewport = { width: 390, height: 800 };
    const size = { width: 280, height: 90 };

    it('goes below the anchor, clamped into the viewport', () => {
      expect(placeTip({ left: 300, top: 100, width: 60, height: 30 }, size, viewport, [])).toEqual({ left: 102, top: 138, side: 'bottom' });
    });

    it('stays between the side safe-area insets (B-796b: iPhone Duo cover status column)', () => {
      // right inset 84: the tip's right edge stops at 390 - 84 - 8.
      expect(placeTip({ left: 300, top: 100, width: 60, height: 30 }, size, { ...viewport, insetRight: 84 }, [])?.left).toBe(390 - 84 - 8 - size.width);
      expect(placeTip({ left: 0, top: 100, width: 60, height: 30 }, size, { ...viewport, insetLeft: 40 }, [])?.left).toBe(48);
    });

    it('flips above when below would hit the composer', () => {
      const composer = { left: 0, top: 650, width: 390, height: 150 };
      expect(placeTip({ left: 20, top: 580, width: 80, height: 28 }, size, viewport, [composer])).toEqual({ left: 20, top: 482, side: 'top' });
    });

    it('flips above near the bottom edge (sidebar settings button)', () => {
      expect(placeTip({ left: 8, top: 760, width: 120, height: 32 }, size, viewport, [])?.side).toBe('top');
    });

    it('refuses to show when both sides would overlap the composer', () => {
      const composer = { left: 0, top: 0, width: 390, height: 800 };
      expect(placeTip({ left: 20, top: 400, width: 80, height: 28 }, size, viewport, [composer])).toBeNull();
    });
  });
});
