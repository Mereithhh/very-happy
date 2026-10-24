import { describe, expect, it } from 'vitest';
import { CHAT_HEADER_IDENTITY_MIN, CHAT_HEADER_WIDE_MIN, chatHeaderCompact, chatHeaderFoldsIdentity, planChatHeaderActions } from './chatHeaderLayout';

describe('planChatHeaderActions', () => {
    it('collapses every icon on a phone so the session title gets the width', () => {
        const plan = planChatHeaderActions({ compact: true, hasBtw: true, hasFiles: true });
        expect(plan.inline).toEqual([]);
        expect(plan.overflow).toEqual(['notes', 'btw', 'files']);
    });

    it('keeps them on the bar where there is room', () => {
        const plan = planChatHeaderActions({ compact: false, hasBtw: true, hasFiles: true });
        expect(plan.inline).toEqual(['notes', 'btw', 'files']);
        expect(plan.overflow).toEqual([]);
    });

    it('omits panels this session cannot host', () => {
        expect(planChatHeaderActions({ compact: false, hasBtw: false, hasFiles: false }).inline).toEqual(['notes']);
        expect(planChatHeaderActions({ compact: true, hasBtw: false, hasFiles: true }).overflow).toEqual(['notes', 'files']);
    });

    it('always offers notes — on mobile this header is its only entry point', () => {
        for (const compact of [true, false]) {
            const plan = planChatHeaderActions({ compact, hasBtw: false, hasFiles: false });
            expect([...plan.inline, ...plan.overflow]).toContain('notes');
        }
    });
});

describe('chatHeaderCompact (B-795)', () => {
    it('follows the header width once measured, not the viewport', () => {
        // 626px unfolded foldable: tablet viewport, but the header is too narrow for five icons.
        expect(chatHeaderCompact(626, true)).toBe(true);
        expect(chatHeaderCompact(CHAT_HEADER_WIDE_MIN, false)).toBe(false);
        expect(chatHeaderCompact(838, true)).toBe(false);
    });
    it('falls back to the viewport test before the first measure', () => {
        expect(chatHeaderCompact(null, true)).toBe(false);
        expect(chatHeaderCompact(null, false)).toBe(true);
    });
});

// B-798 P1-9: phone headers fold agent · machine + relay into ⋯ so the trail and title stay readable.
describe('chatHeaderFoldsIdentity', () => {
    it('folds on phone and Duo-cover widths (390, 466)', () => {
        expect(chatHeaderFoldsIdentity(390, false)).toBe(true);
        expect(chatHeaderFoldsIdentity(466, false)).toBe(true);
        expect(chatHeaderFoldsIdentity(CHAT_HEADER_IDENTITY_MIN - 1, true)).toBe(true);
    });
    it('keeps them on the bar from 480px of header up (unfolded foldables, tablets)', () => {
        expect(chatHeaderFoldsIdentity(CHAT_HEADER_IDENTITY_MIN, false)).toBe(false);
        expect(chatHeaderFoldsIdentity(626, false)).toBe(false);
    });
    it('falls back to the viewport before the header is measured', () => {
        expect(chatHeaderFoldsIdentity(null, false)).toBe(true);
        expect(chatHeaderFoldsIdentity(null, true)).toBe(false);
    });
});
