import { describe, it, expect } from 'vitest';
import {
    MAX_PREVIEW_PATH_CHARS,
    normalizePreviewMode,
    normalizePreviewPath,
    resolvePreviewTarget,
} from './filePreview';

describe('normalizePreviewPath', () => {
    it('keeps a normal absolute path', () => {
        expect(normalizePreviewPath('/Users/jojo/report.md')).toBe('/Users/jojo/report.md');
    });

    it('keeps interior spaces but trims the edges', () => {
        expect(normalizePreviewPath('  /tmp/my report.md\n')).toBe('/tmp/my report.md');
    });

    it('rejects non-strings, empties and whitespace-only payloads', () => {
        expect(normalizePreviewPath(undefined)).toBeNull();
        expect(normalizePreviewPath(null)).toBeNull();
        expect(normalizePreviewPath(42)).toBeNull();
        expect(normalizePreviewPath({ path: '/tmp/a' })).toBeNull();
        expect(normalizePreviewPath('')).toBeNull();
        expect(normalizePreviewPath('   \n ')).toBeNull();
    });

    it('rejects an over-long path and NUL bytes', () => {
        expect(normalizePreviewPath('/a'.repeat(MAX_PREVIEW_PATH_CHARS))).toBeNull();
        expect(normalizePreviewPath('/tmp/a\u0000b')).toBeNull();
    });
});

describe('normalizePreviewMode', () => {
    it('defaults to file and only recognizes diff', () => {
        expect(normalizePreviewMode(undefined)).toBe('file');
        expect(normalizePreviewMode('file')).toBe('file');
        expect(normalizePreviewMode('diff')).toBe('diff');
        // forward compat: a mode a newer CLI invents must not break an older web
        expect(normalizePreviewMode('hologram')).toBe('file');
    });
});

describe('resolvePreviewTarget', () => {
    const lookup = (id: string) => (id === 'sess-with-machine' ? 'machine-1' : undefined);

    it('maps a session to its metadata.machineId', () => {
        expect(resolvePreviewTarget({ sourceType: 'session', sessionId: 'sess-with-machine' }, lookup))
            .toEqual({ ok: true, machineId: 'machine-1' });
    });

    it('reports a session that has no machineId instead of silently doing nothing', () => {
        expect(resolvePreviewTarget({ sourceType: 'session', sessionId: 'sess-orphan' }, lookup))
            .toEqual({ ok: false, reason: 'session-without-machine' });
    });

    it('takes a machine source at face value', () => {
        expect(resolvePreviewTarget({ sourceType: 'machine', machineId: 'machine-9' }, lookup))
            .toEqual({ ok: true, machineId: 'machine-9' });
    });

    it('reports a source with no usable id', () => {
        expect(resolvePreviewTarget({ sourceType: 'machine' }, lookup))
            .toEqual({ ok: false, reason: 'no-source' });
        expect(resolvePreviewTarget({ sourceType: 'session' }, lookup))
            .toEqual({ ok: false, reason: 'no-source' });
    });
});
