/**
 * B-563 / B-564 / B-568 pure rules (specs/2026-10-composer-mobile-ux.md).
 */
import { describe, expect, it } from 'vitest';
import { isDockCollapsed, requestSummary } from './permissionDock';
import { askPrimaryAction, canTakePrimaryAction, isQuestionAnswered, shouldAutoAdvance } from './askStepper';
import { focusAfterSend } from './composerSendFocus';
import { isSocketDown } from './reconnectHint';
import { computeImageDownscale, shouldDownscaleImage } from './imageDownscale';

describe('B-563 permission dock folding', () => {
    it('is open when nothing was folded or nothing is pending', () => {
        expect(isDockCollapsed(null, ['a'])).toBe(false);
        expect(isDockCollapsed(['a'], [])).toBe(false);
    });
    it('stays folded while every pending request was already folded (one answered)', () => {
        expect(isDockCollapsed(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(isDockCollapsed(['a', 'b'], ['b'])).toBe(true);
    });
    it('re-opens when a request the user has not seen arrives', () => {
        expect(isDockCollapsed(['a'], ['a', 'c'])).toBe(false);
    });
    it('summarises tool + command / path / question first line', () => {
        expect(requestSummary({ tool: 'Bash', arguments: { command: '\n git push origin\nmore' } })).toBe('Bash · git push origin');
        expect(requestSummary({ tool: 'Edit', arguments: { file_path: '/a/b.ts' } })).toBe('Edit · /a/b.ts');
        expect(requestSummary({ tool: 'AskUserQuestion', arguments: { questions: [{ question: 'Which DB?' }] } })).toBe('AskUserQuestion · Which DB?');
        expect(requestSummary({ tool: 'Mystery', arguments: null })).toBe('Mystery');
    });
});

describe('B-564 ask stepper', () => {
    it('auto-advances only a single-select option pick before the last question', () => {
        expect(shouldAutoAdvance({ multi: false, other: false, index: 0, total: 3 })).toBe(true);
        expect(shouldAutoAdvance({ multi: true, other: false, index: 0, total: 3 })).toBe(false);
        expect(shouldAutoAdvance({ multi: false, other: true, index: 0, total: 3 })).toBe(false);
        expect(shouldAutoAdvance({ multi: false, other: false, index: 2, total: 3 })).toBe(false);
    });
    it('the last question submits; next needs the current answer, submit needs all', () => {
        expect(askPrimaryAction(0, 2)).toBe('next');
        expect(askPrimaryAction(1, 2)).toBe('submit');
        expect(canTakePrimaryAction({}, 0, 2)).toBe(false);
        expect(canTakePrimaryAction({ 0: ['A'] }, 0, 2)).toBe(true);
        expect(canTakePrimaryAction({ 1: ['B'] }, 1, 2)).toBe(false);
        expect(canTakePrimaryAction({ 0: ['A'], 1: ['B'] }, 1, 2)).toBe(true);
        expect(isQuestionAnswered({ 0: [] }, 0)).toBe(false);
    });
});

describe('B-568 composer focus after send', () => {
    it('desktop always refocuses', () => {
        for (const outcome of ['sent', 'queued', 'failed'] as const) {
            expect(focusAfterSend({ coarse: false, hadFocus: false, outcome })).toBe('focus');
        }
    });
    it('touch: a send that reached the agent puts the keyboard away', () => {
        expect(focusAfterSend({ coarse: true, hadFocus: true, outcome: 'sent' })).toBe('blur');
    });
    it('touch: queued / failed keep the had-focus rule (back-to-back queueing)', () => {
        expect(focusAfterSend({ coarse: true, hadFocus: true, outcome: 'queued' })).toBe('focus');
        expect(focusAfterSend({ coarse: true, hadFocus: false, outcome: 'queued' })).toBe('none');
        expect(focusAfterSend({ coarse: true, hadFocus: true, outcome: 'failed' })).toBe('focus');
        expect(focusAfterSend({ coarse: true, hadFocus: false, outcome: 'failed' })).toBe('none');
    });
});

describe('B-568 reconnect hint', () => {
    it('treats every non-connected status as down', () => {
        expect(isSocketDown('connected')).toBe(false);
        expect(isSocketDown('connecting')).toBe(true);
        expect(isSocketDown('disconnected')).toBe(true);
        expect(isSocketDown('error')).toBe(true);
    });
});

describe('B-568 image downscale', () => {
    it('only jpeg / png / webp', () => {
        expect(shouldDownscaleImage('image/jpeg')).toBe(true);
        expect(shouldDownscaleImage('IMAGE/PNG')).toBe(true);
        expect(shouldDownscaleImage('image/webp')).toBe(true);
        for (const mime of ['image/gif', 'image/svg+xml', 'image/heic', 'application/pdf', '']) {
            expect(shouldDownscaleImage(mime)).toBe(false);
        }
    });
    it('caps the long edge at 2000 keeping the aspect ratio', () => {
        expect(computeImageDownscale(3000, 2000)).toEqual({ width: 2000, height: 1333 });
        expect(computeImageDownscale(3024, 4032)).toEqual({ width: 1500, height: 2000 });
        expect(computeImageDownscale(4000, 4000)).toEqual({ width: 2000, height: 2000 });
        expect(computeImageDownscale(10000, 3)).toEqual({ width: 2000, height: 1 });
    });
    it('leaves fitting or unusable sizes alone', () => {
        expect(computeImageDownscale(2000, 1000)).toBeNull();
        expect(computeImageDownscale(800, 600)).toBeNull();
        expect(computeImageDownscale(0, 3000)).toBeNull();
        expect(computeImageDownscale(Number.NaN, 3000)).toBeNull();
    });
});
