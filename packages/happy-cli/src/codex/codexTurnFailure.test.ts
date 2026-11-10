import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexTurnFailure } from './codexTurnFailure';

describe('B-913 Codex turn failure', () => {
    it('a failed task_complete / turn_aborted is a turn failure with a status when the text has one', () => {
        expect(codexTurnFailure('unexpected status 400 Bad Request: model is not supported', 5)).toEqual({
            at: 5, summary: 'unexpected status 400 Bad Request: model is not supported', provider: 'codex', status: 400,
        });
        expect(codexTurnFailure('stream disconnected before completion', 5)).toMatchObject({ status: null });
    });
    it('no failure / account problems (own banners) are not', () => {
        expect(codexTurnFailure(null)).toBeNull();
        expect(codexTurnFailure('unexpected status 401 Unauthorized: invalid token')).toBeNull();
    });
});

describe('B-913 runCodex wiring', () => {
    const src = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
    it('turn failures are noted on both failing events, cleared when a prompt starts a turn', () => {
        expect(src).toMatch(/addMessage\(`Task failed: \$\{failure\}`, 'status'\);\n\s*noteTurnFailure\(failure\);/);
        expect(src).toMatch(/addMessage\(`Turn aborted: \$\{failure\}`, 'status'\);\n\s*noteTurnFailure\(failure\);/);
        expect(src).toMatch(/\/\/ B-913: a new prompt[^\n]*\n\s*turnFailure = null;\n\s*session\.clearTurnFailure\(\);\n\s*idleRelease\.cancel\(\);\n\s*turnActive = true;/);
    });
    it('the ready push becomes the one turn-failed push (never both)', () => {
        const ready = src.slice(src.indexOf('const sendReady = () => {'), src.indexOf('// Debug helper: log active handles'));
        expect(ready).toMatch(/if \(failed\) \{[\s\S]*sendTurnFailedNotification\([\s\S]*return;\s*\}/);
        expect(ready.indexOf('sendTurnFailedNotification(')).toBeLessThan(ready.indexOf("kind: 'done'"));
    });
    it('declares the capability', () => {
        expect(src).toContain('metadata.capabilities = [...metadata.capabilities, TURN_FAILURE_CAPABILITY];');
    });
});
