/**
 * B-563 / B-564 / B-568 pure rules (specs/2026-10-composer-mobile-ux.md).
 */
import { describe, expect, it } from 'vitest';
import { isDockCollapsed, pendingDockRequestIds, requestSummary, transcriptQuestionPlacement } from './permissionDock';
import { askPrimaryAction, canTakePrimaryAction, isQuestionAnswered, shouldAutoAdvance } from './askStepper';
import { focusAfterSend, isSoftKeyboardOpen } from './composerSendFocus';
import { isReconnecting, isSocketDown } from './reconnectHint';
import { computeImageDownscale, isAnimatedImage, shouldDownscaleImage } from './imageDownscale';

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
            expect(focusAfterSend({ coarse: false, hadFocus: false, softKeyboard: false, outcome })).toBe('focus');
        }
    });
    it('touch: a send that reached the agent puts the SOFT keyboard away', () => {
        expect(focusAfterSend({ coarse: true, hadFocus: true, softKeyboard: true, outcome: 'sent' })).toBe('blur');
    });
    it('touch + hardware keyboard (iPad Cmd+Enter): nothing to dismiss, caret stays', () => {
        expect(focusAfterSend({ coarse: true, hadFocus: true, softKeyboard: false, outcome: 'sent' })).toBe('focus');
    });
    it('touch: queued / failed keep the had-focus rule (back-to-back queueing)', () => {
        expect(focusAfterSend({ coarse: true, hadFocus: true, softKeyboard: true, outcome: 'queued' })).toBe('focus');
        expect(focusAfterSend({ coarse: true, hadFocus: false, softKeyboard: false, outcome: 'queued' })).toBe('none');
        expect(focusAfterSend({ coarse: true, hadFocus: true, softKeyboard: true, outcome: 'failed' })).toBe('focus');
        expect(focusAfterSend({ coarse: true, hadFocus: false, softKeyboard: false, outcome: 'failed' })).toBe('none');
    });
    const base = { keyboardOpenAttr: false, visualHeight: null as number | null, innerWidth: 390, innerHeight: 760, screenWidth: 390, screenHeight: 844 };
    it('detects the iOS overlay keyboard (pin attribute or visualViewport gap)', () => {
        expect(isSoftKeyboardOpen({ ...base, keyboardOpenAttr: true })).toBe(true);
        expect(isSoftKeyboardOpen({ ...base, visualHeight: 420 })).toBe(true);
    });
    it('detects the Android resized layout viewport', () => {
        expect(isSoftKeyboardOpen({ ...base, innerHeight: 430, screenWidth: 412, screenHeight: 915, innerWidth: 412 })).toBe(true);
        expect(isSoftKeyboardOpen({ ...base, innerWidth: 915, innerHeight: 160, screenWidth: 412, screenHeight: 915 })).toBe(true);
    });
    it('no soft keyboard: phone at rest, iPad with a hardware keyboard in either orientation', () => {
        expect(isSoftKeyboardOpen({ ...base, visualHeight: 760 })).toBe(false);
        expect(isSoftKeyboardOpen({ keyboardOpenAttr: false, visualHeight: 950, innerWidth: 1366, innerHeight: 950, screenWidth: 1024, screenHeight: 1366 })).toBe(false);
        expect(isSoftKeyboardOpen({ keyboardOpenAttr: false, visualHeight: 1290, innerWidth: 1024, innerHeight: 1290, screenWidth: 1024, screenHeight: 1366 })).toBe(false);
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

describe('B-568 reconnect hint only after a lost connection', () => {
    it('cold start (never connected) is not a reconnect', () => {
        expect(isReconnecting('disconnected', false)).toBe(false);
        expect(isReconnecting('connecting', false)).toBe(false);
    });
    it('a drop after the first connect is', () => {
        expect(isReconnecting('disconnected', true)).toBe(true);
        expect(isReconnecting('connected', true)).toBe(false);
    });
});

function pngChunks(types: string[]): Uint8Array {
    const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const type of types) {
        const data = type === 'IHDR' ? 13 : 4;
        parts.push(0, 0, 0, data, ...[...type].map((c) => c.charCodeAt(0)), ...new Array(data).fill(0), 0, 0, 0, 0);
    }
    return new Uint8Array(parts);
}
function webp(chunks: Array<[string, number[]]>): Uint8Array {
    const body: number[] = [...'WEBP'].map((c) => c.charCodeAt(0));
    for (const [type, data] of chunks) {
        const len = data.length;
        body.push(...[...type].map((c) => c.charCodeAt(0)), len & 255, (len >> 8) & 255, 0, 0, ...data, ...(len % 2 ? [0] : []));
    }
    const size = body.length;
    return new Uint8Array([...[...'RIFF'].map((c) => c.charCodeAt(0)), size & 255, (size >> 8) & 255, 0, 0, ...body]);
}

describe('B-568 animated images are never redrawn', () => {
    it('APNG: acTL before IDAT', () => {
        expect(isAnimatedImage(pngChunks(['IHDR', 'acTL', 'IDAT', 'IEND']), 'image/png')).toBe(true);
        expect(isAnimatedImage(pngChunks(['IHDR', 'iCCP', 'IDAT', 'IEND']), 'image/png')).toBe(false);
    });
    it('WebP: VP8X animation flag or ANIM/ANMF chunk', () => {
        expect(isAnimatedImage(webp([['VP8X', [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]]]), 'image/webp')).toBe(true);
        expect(isAnimatedImage(webp([['VP8X', [0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]], ['ANIM', [0, 0, 0, 0, 0, 0]]]), 'image/webp')).toBe(true);
        expect(isAnimatedImage(webp([['VP8X', [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]], ['VP8 ', [1, 2, 3]]]), 'image/webp')).toBe(false);
        expect(isAnimatedImage(webp([['VP8L', [1, 2, 3, 4]]]), 'image/webp')).toBe(false);
    });
    it('unparseable headers keep the original; JPEG is never animated', () => {
        expect(isAnimatedImage(new Uint8Array([1, 2, 3]), 'image/png')).toBe(true);
        expect(isAnimatedImage(new Uint8Array([1, 2, 3]), 'image/webp')).toBe(true);
        expect(isAnimatedImage(new Uint8Array([0xff, 0xd8]), 'image/jpeg')).toBe(false);
    });
});

describe('B-563 dock request set and transcript placement', () => {
    it('drops ids already in completedRequests', () => {
        expect(pendingDockRequestIds({ a: {}, b: {} }, { a: {} })).toEqual(['b']);
        expect(pendingDockRequestIds(null, { a: {} })).toEqual([]);
        expect(pendingDockRequestIds({ a: {} }, undefined)).toEqual(['a']);
    });
    it('mirror sessions are read-only in the transcript too (B-105)', () => {
        expect(transcriptQuestionPlacement({ mirror: true, pendingIds: ['r'], requestId: 'r' })).toBe('readonly');
        expect(transcriptQuestionPlacement({ mirror: true, pendingIds: [], requestId: 'r' })).toBe('readonly');
        expect(transcriptQuestionPlacement({ mirror: false, pendingIds: ['r'], requestId: 'r' })).toBe('dock');
        expect(transcriptQuestionPlacement({ mirror: false, pendingIds: [], requestId: 'r' })).toBe('inline');
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
