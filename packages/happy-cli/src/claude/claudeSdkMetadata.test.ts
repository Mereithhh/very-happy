import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import { applyClaudeSdkMetadata } from './claudeSdkMetadata';

const base = { path: '/repo', host: 'machine' } as Metadata;

describe('applyClaudeSdkMetadata', () => {
    it('advertises the attachment blocks supported by this daemon', () => {
        const metadata = applyClaudeSdkMetadata(base, { modelIsDefault: true });
        expect(metadata.attachmentKinds)
            .toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', '*/*']);
        expect(metadata.queueCancellation).toBe(true);
    });

    it('records the resolved model only when the SDK query followed machine defaults', () => {
        expect(applyClaudeSdkMetadata(base, {
            model: 'claude-opus-5[1m]',
            modelIsDefault: true,
        }).defaultModelCode).toBe('claude-opus-5[1m]');
    });

    it('does not overwrite the machine default with an explicit per-message model', () => {
        const current = { ...base, defaultModelCode: 'claude-opus-5[1m]' };
        expect(applyClaudeSdkMetadata(current, {
            model: 'claude-haiku-4-5',
            modelIsDefault: false,
        }).defaultModelCode).toBe('claude-opus-5[1m]');
    });

    /**
     * B-292: this field is the web's ONLY ground truth for "did my model switch
     * take effect" — the picker otherwise renders the client's own optimistic
     * intent, which is what kept the swallowed-switch bug invisible. It must be
     * published on EVERY init, explicit model or not, since Claude Code re-emits
     * init at every turn boundary with the model actually in force.
     */
    it('publishes the model Claude Code says it is running, default or not', () => {
        expect(applyClaudeSdkMetadata(base, {
            model: 'claude-sonnet-5',
            modelIsDefault: false,
        }).currentModelCode).toBe('claude-sonnet-5');
        expect(applyClaudeSdkMetadata(base, {
            model: 'claude-opus-5[1m]',
            modelIsDefault: true,
        }).currentModelCode).toBe('claude-opus-5[1m]');
    });

    it('leaves a previously published running model alone when the SDK reports none', () => {
        const current = { ...base, currentModelCode: 'claude-sonnet-5' };
        expect(applyClaudeSdkMetadata(current, { modelIsDefault: false }).currentModelCode)
            .toBe('claude-sonnet-5');
    });
});
