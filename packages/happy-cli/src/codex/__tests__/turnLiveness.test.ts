/**
 * B-622: a Codex session reports `thinking` for as long as the wrapper owns a
 * prompt — from the moment it is dequeued (app-server respawn, thread resume,
 * turn/start all happen before Codex's own task_started) until the turn ends
 * — so the web's "still running?" verdict (sync/agentLiveness.ts) never goes
 * dark while work is in flight. Source assertions verified with
 * scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Comments stripped and the blank lines they leave collapsed, so the assertions
// below pin code, not prose.
const source = readFileSync(new URL('../runCodex.ts', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');

describe('Codex turn liveness', () => {
    it('raises thinking the moment a prompt is dequeued, before any app-server work', () => {
        // Taking ownership of the prompt (idleRelease.cancel / turnActive) is
        // preceded by the keepAlive that lights the web up…
        expect(source).toContain("if (!thinking) {\n                thinking = true;\n                session.keepAlive(thinking, 'remote');\n            }\n            idleRelease.cancel();\n            turnActive = true;");
        // …and that is before the first thing that can take seconds (the
        // app-server respawn + thread resume) and before Codex's own task_started.
        const at = source.indexOf('idleRelease.cancel();\n            turnActive = true;');
        expect(at).toBeGreaterThan(0);
        expect(at - source.lastIndexOf("session.keepAlive(thinking, 'remote');", at)).toBeLessThan(80);
        expect(at).toBeLessThan(source.indexOf('await client.ensureConnected();'));
    });

    it('still drops thinking when the turn ends, however it ends', () => {
        // The event path (task_complete / turn_aborted)…
        expect(source).toContain("if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {\n            if (thinking) {\n                logger.debug('thinking completed');\n                thinking = false;\n                session.keepAlive(thinking, 'remote');");
        // …and the loop's finally, which also covers a thrown turn/start.
        const finallyAt = source.indexOf('} finally {\n                permissionHandler.reset();');
        expect(finallyAt).toBeGreaterThan(0);
        expect(source.slice(finallyAt, finallyAt + 500)).toContain("thinking = false;\n                session.keepAlive(thinking, 'remote');");
    });

    it('shows Codex retry notices as they happen', () => {
        expect(source).toContain("} else if (msg.type === 'turn_retry') {");
        const at = source.indexOf("} else if (msg.type === 'turn_retry') {");
        expect(source.slice(at, at + 400)).toContain("session.sendSessionEvent({ type: 'message', message: notice });");
    });
});
