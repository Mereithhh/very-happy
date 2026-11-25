import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// B-975: the notice and the landing hold are only as good as their wiring.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('effort downgrade wiring (B-975)', () => {
    it('the composer shows the notice and picks what the next message sends', () => {
        const src = read('./AgentInput.tsx');
        expect(src).toContain('data-testid="effort-unsupported">{effortNotice}</div>');
        expect(src).toContain('session ? codexEffortDowngrade(session, runSettings, latestTable)');
        expect(src).toMatch(/codexSendEffort,\n\s+pending \? pending\.effortLevel/);
        // Nothing leaves before a yes — draft and session alike.
        expect(src).toContain('if (!(await confirmEffort()) || draftRef.current !== draft) return;');
        expect(src).toContain('if (compactCommand === null && (!(await confirmEffort()) || (!request && draftRef.current !== draft))) { request?.onResult(false); return; }');
        expect(src).toContain("if (ok) setMode('updateSessionEffortLevel', 'effortLevel', actual ?? (pending ? null : EFFORT_PICK_AUTO));");
        expect(src).toContain('modeMeta: resolveMessageModeMeta(storage.getState().sessions[sessionId] ?? session, storage.getState().settings),');
    });
    it('a landing session re-checks before its first message', () => {
        const src = read('../../sync/pendingSessionsRuntime.ts');
        expect(src).toContain('session ? codexEffortDowngrade(session, settings) : null');
        expect(src).toContain("t('pendingSession.effortHeld'");
    });
});
