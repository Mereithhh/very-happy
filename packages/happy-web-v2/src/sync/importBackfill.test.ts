/**
 * B-880: an import still uploading is parked (no catch-up, no pushes) and
 * opens on its newest page once the wrapper's final marker lands.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importUploadProgress } from './importBackfill';
import { MetadataSchema } from './storageTypes';

const session = (forkBackfill: unknown, active = true) => ({ active, metadata: { path: '/x', host: 'h', forkBackfill } as never });

describe('B-880 importUploadProgress', () => {
    it('uploading = done:false on an active session', () => {
        expect(importUploadProgress(session({ done: false, total: 3174, sent: 2400 }))).toEqual({ total: 3174, sent: 2400 });
        // announced before the transcript is read: no total yet
        expect(importUploadProgress(session({ done: false, total: 0, sent: 0 }))).toEqual({ total: 0, sent: 0 });
        expect(importUploadProgress(session({ done: false }))).toEqual({ total: 0, sent: 0 });
        expect(importUploadProgress(session({ done: false, total: 10, sent: 99 }))).toEqual({ total: 10, sent: 10 });
    });

    it('done, never imported, older wrappers (final marker only) → a normal session', () => {
        expect(importUploadProgress(session({ done: true, count: 95, completedAt: 1 }))).toBeNull();
        expect(importUploadProgress(session(undefined))).toBeNull();
        expect(importUploadProgress(null)).toBeNull();
        expect(importUploadProgress({ active: true, metadata: null })).toBeNull();
    });

    it('a wrapper that died mid-upload never leaves the session parked', () => {
        expect(importUploadProgress(session({ done: false, total: 100, sent: 40 }, false))).toBeNull();
    });

    it('the metadata schema keeps the progress fields', () => {
        const parsed = MetadataSchema.parse({ path: '/x', host: 'h', forkBackfill: { done: false, total: 31674, sent: 1200 } });
        expect(parsed.forkBackfill).toEqual({ done: false, total: 31674, sent: 1200 });
    });
});

/** Strip comments so an assertion cannot be satisfied by the comment explaining it. */
const code = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('B-880 wiring (source assertions, verified with mutation-check)', () => {
    const source = code('sync.ts');
    const fn = (name: string) => {
        const start = source.indexOf(name);
        expect(start).toBeGreaterThan(-1);
        return source.slice(start, start + 2_500);
    };

    it('every path that would take the replay in is gated', () => {
        expect(fn('onSessionEnter = (sessionId: string) => {')).toMatch(/if \(!this\.parkIfImporting\(sessionId\)\) \{\s*this\.syncScheduler\.open\(sessionId\);/);
        expect(fn('private fetchMessages = async')).toContain('if (this.parkIfImporting(sessionId)) return;');
        expect(fn('private handleRelayCommittedMessages = async')).toContain('if (this.parkIfImporting(payload.sessionId)) return;');
        const push = fn("if (updateData.body.t === 'new-message') {");
        expect(push.indexOf('if (this.parkIfImporting(updateData.body.sid)) {')).toBeGreaterThan(-1);
        expect(push.indexOf('if (this.parkIfImporting(updateData.body.sid)) {')).toBeLessThan(push.indexOf('decryptMessage('));
    });

    it('parking stops a subscription opened before the marker; release reloads from the newest page', () => {
        expect(fn('private parkIfImporting(sessionId: string): boolean {')).toContain('this.syncScheduler.forget(sessionId);');
        const release = fn('private releaseImportParked() {');
        expect(release).toContain('this.invalidateSessionWindow(sessionId)');
        expect(release).toContain('if (this.isViewed(sessionId)) this.onSessionEnter(sessionId);');
        expect(fn('private applySessions = (sessions')).toContain('if (this.importParked.size > 0) this.releaseImportParked();');
    });
});
