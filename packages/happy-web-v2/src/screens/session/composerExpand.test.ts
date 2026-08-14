import { describe, it, expect } from 'vitest';
import { COMPOSER_MAX_HEIGHT, composerHeightCap } from './composerExpand';

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
