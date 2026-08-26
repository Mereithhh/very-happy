import { describe, it, expect } from 'vitest';
import {
    COMPOSER_MAX_HEIGHT,
    COMPOSER_MOBILE_MIN_HEIGHT,
    composerHeightCap,
    composerTextareaHeight,
} from './composerExpand';

describe('composerHeightCap', () => {
    it('常态：恒为 200，与视口无关', () => {
        expect(composerHeightCap(false, 1080)).toBe(COMPOSER_MAX_HEIGHT);
        expect(composerHeightCap(false, 300)).toBe(COMPOSER_MAX_HEIGHT);
    });

    it('展开态：约 60% 视口高（四舍五入）', () => {
        expect(composerHeightCap(true, 1000)).toBe(600);
        expect(composerHeightCap(true, 901)).toBe(541); // 540.6 → 541
    });

    it('展开态在小视口下不低于常态上限（展开绝不把输入框变矮）', () => {
        expect(composerHeightCap(true, 300)).toBe(COMPOSER_MAX_HEIGHT); // 180 → 夹回 200
        expect(composerHeightCap(true, 0)).toBe(COMPOSER_MAX_HEIGHT);
    });
});

describe('composerTextareaHeight', () => {
    it('visibly expands empty and short input instead of only raising its cap', () => {
        expect(composerTextareaHeight(true, 24, 1000)).toBe(600);
        expect(composerTextareaHeight(true, 80, 1000)).toBe(600);
    });

    it('keeps collapsed input content-sized up to the normal cap', () => {
        expect(composerTextareaHeight(false, 24, 1000)).toBe(24);
        expect(composerTextareaHeight(false, 180, 1000)).toBe(180);
        expect(composerTextareaHeight(false, 420, 1000)).toBe(COMPOSER_MAX_HEIGHT);
    });

    it('gives a phone composer a useful three-line minimum without changing desktop sizing', () => {
        expect(composerTextareaHeight(false, 24, 800, COMPOSER_MOBILE_MIN_HEIGHT)).toBe(72);
        expect(composerTextareaHeight(false, 120, 800, COMPOSER_MOBILE_MIN_HEIGHT)).toBe(120);
        expect(composerTextareaHeight(false, 24, 800)).toBe(24);
    });

    it('tracks the available viewport while expanded', () => {
        expect(composerTextareaHeight(true, 24, 800)).toBe(480);
        expect(composerTextareaHeight(true, 24, 400)).toBe(240);
        expect(composerTextareaHeight(true, 24, 300)).toBe(COMPOSER_MAX_HEIGHT);
    });
});
