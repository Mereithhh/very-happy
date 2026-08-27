import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import { applyClaudeSdkMetadata } from './claudeSdkMetadata';

const base = { path: '/repo', host: 'machine' } as Metadata;

describe('applyClaudeSdkMetadata', () => {
    it('advertises the attachment blocks supported by this daemon', () => {
        expect(applyClaudeSdkMetadata(base, { modelIsDefault: true }).attachmentKinds)
            .toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
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
});
