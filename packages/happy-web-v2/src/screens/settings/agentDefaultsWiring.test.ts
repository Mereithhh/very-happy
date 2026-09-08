import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * B-370 wiring guard (source assertions, same style as help/helpScreen.test.ts):
 * the pure functions are unit-tested next to them; this pins that the screens
 * actually consume them for pi instead of the Claude path.
 */
const settings = readFileSync(new URL('./SettingsRoutes.tsx', import.meta.url), 'utf8');
const agentInput = readFileSync(new URL('../session/AgentInput.tsx', import.meta.url), 'utf8');

describe('Settings → Agents renders pi as its own row', () => {
    it('iterates agentKeys (which now include pi) and feeds pi the published model list, not Claude aliases', () => {
        expect(settings).toContain('{agentKeys.map((agent) => {');
        expect(settings).toContain("import { collectPiModelOptions } from '@/sync/piModelOptions';");
        expect(settings).toContain("const modelOptions = agent === 'pi' ? piModelOptions : getHardcodedModelModes(agent, translate);");
        expect(settings).toContain('collectPiModelOptions(allSessions, [piModelOverride])');
    });
});

describe('session selectors write through the session flavor', () => {
    it('AgentInput persists picks with setAgentDefaultOverride(…, flavor, …) so an acp session lands in the pi slot', () => {
        expect(agentInput).toContain('agentDefaultOverrides: setAgentDefaultOverride(currentOverrides, flavor, field, key),');
        expect(agentInput).toContain('const agentDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, flavor);');
        // honesty subtitles cover pi too (it publishes permissionMode + currentModelCode); steer/live-RPC stay Claude-only
        expect(agentInput).toContain('const publishesModeFacts = isClaudeFlavor || isPiAgent(flavor);');
        expect(agentInput).toContain('const permissionDisplayState = publishesModeFacts');
    });
});
