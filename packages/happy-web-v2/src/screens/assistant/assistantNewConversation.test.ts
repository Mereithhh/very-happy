import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-916c (QA77 #8): the legacy /assistant page's 「新对话」 re-spawns the assistant,
 * which becomes the main agent — only on a daemon that advertises
 * `daemonState.mainAgentGates` (never on a CLI version floor).
 */
const src = readFileSync(join(__dirname, 'AssistantScreen.tsx'), 'utf8');

describe('legacy assistant new conversation is gated on the main agent capability', () => {
    it('refuses (with the upgrade text) before any respawn', () => {
        const body = src.slice(src.indexOf('const onNewConversation = useCallback'), src.indexOf('}, [machine, resetting, spawnAssistant'));
        expect(body).toContain('if (!mainAgentSupported(machine)) {');
        expect(body.indexOf('if (!mainAgentSupported(machine)) {')).toBeLessThan(body.indexOf('spawnAssistant(machine.id, { forceNew: true })'));
    });
    it('the button is disabled without the capability', () => {
        expect(src).toContain('const canStartNew = mainAgentSupported(machine);');
        expect(src).toContain('disabled={!machine || resetting || !canStartNew}');
    });
});
