import { describe, expect, it } from 'vitest';
import {
    AgentDefaultOverridesSchema,
    agentKeys,
    getCodeAgentDefaults,
    getReviewFirstPermissionMode,
    isPiAgent,
    normalizeAgentKey,
    resolveAgentDefaultConfig,
    resolveNewSessionPermissionMode,
    setAgentDefaultOverride,
} from './agentDefaults';

describe('persistent conversation defaults', () => {
    it('persists each composer selection for the same agent without losing sibling fields', () => {
        let overrides = setAgentDefaultOverride({}, 'claude', 'modelMode', 'opus');
        overrides = setAgentDefaultOverride(overrides, 'claude', 'permissionMode', 'bypassPermissions');
        overrides = setAgentDefaultOverride(overrides, 'claude', 'effortLevel', 'high');

        expect(resolveAgentDefaultConfig(overrides, 'claude')).toEqual({
            modelMode: 'opus',
            permissionMode: 'bypassPermissions',
            effortLevel: 'high',
        });
    });

    it('keeps agent defaults isolated', () => {
        const overrides = setAgentDefaultOverride({}, 'codex', 'permissionMode', 'yolo');

        expect(resolveAgentDefaultConfig(overrides, 'codex').permissionMode).toBe('yolo');
        expect(resolveAgentDefaultConfig(overrides, 'claude').permissionMode).toBe('bypassPermissions');
    });

    it('clears an explicit effort choice when the composer returns to default', () => {
        const selected = setAgentDefaultOverride({}, 'claude', 'effortLevel', 'high');
        const reset = setAgentDefaultOverride(selected, 'claude', 'effortLevel', null);

        expect(resolveAgentDefaultConfig(reset, 'claude').effortLevel).toBeNull();
        expect(reset.claude).toBeUndefined();
    });
});

describe('pi is a first-class agent key (B-370)', () => {
    it('is listed with its own code defaults: model follows the machine, yolo is the Claude key', () => {
        expect(agentKeys).toContain('pi');
        expect(getCodeAgentDefaults('pi')).toEqual({ permissionMode: 'bypassPermissions', modelMode: 'default', effortLevel: null });
        // review-first: the pi-side gate treats plan/acceptEdits as default, so `default` is the honest key
        expect(getReviewFirstPermissionMode('pi')).toBe('default');
    });

    it("maps both the launcher key 'pi' and the session flavor 'acp' to the pi slot", () => {
        expect(normalizeAgentKey('pi')).toBe('pi');
        expect(normalizeAgentKey('acp')).toBe('pi');
        expect(isPiAgent('acp')).toBe(true);
        // everything else is untouched
        expect(normalizeAgentKey('claude')).toBe('claude');
        expect(normalizeAgentKey(undefined)).toBe('claude');
        expect(normalizeAgentKey('codex')).toBe('codex');
        expect(normalizeAgentKey('gemini')).toBe('gemini');
        expect(normalizeAgentKey('openclaw')).toBe('openclaw');
        expect(isPiAgent('claude')).toBe(false);
    });

    it('pi and claude overrides never overwrite each other (either direction)', () => {
        // Settings → Agents writes with the agent key; a running pi session writes with its flavor 'acp'.
        let overrides = setAgentDefaultOverride({}, 'claude', 'modelMode', 'opus');
        overrides = setAgentDefaultOverride(overrides, 'acp', 'modelMode', 'llm-hub/claude-fable-5-1');
        expect(resolveAgentDefaultConfig(overrides, 'claude').modelMode).toBe('opus');
        expect(resolveAgentDefaultConfig(overrides, 'pi').modelMode).toBe('llm-hub/claude-fable-5-1');
        expect(resolveAgentDefaultConfig(overrides, 'acp').modelMode).toBe('llm-hub/claude-fable-5-1');
        expect(overrides).toEqual({
            claude: { modelMode: 'opus' },
            pi: { modelMode: 'llm-hub/claude-fable-5-1' },
        });

        // and back: changing claude afterwards leaves pi alone
        overrides = setAgentDefaultOverride(overrides, 'claude', 'modelMode', 'sonnet');
        overrides = setAgentDefaultOverride(overrides, 'claude', 'permissionMode', 'plan');
        expect(overrides.pi).toEqual({ modelMode: 'llm-hub/claude-fable-5-1' });
        expect(resolveAgentDefaultConfig(overrides, 'pi').permissionMode).toBe('bypassPermissions');

        // clearing pi does not touch claude
        overrides = setAgentDefaultOverride(overrides, 'pi', 'modelMode', null);
        expect(overrides.pi).toBeUndefined();
        expect(overrides.claude).toEqual({ modelMode: 'sonnet', permissionMode: 'plan' });
    });

    it('a claude override no longer leaks into pi new-session permission resolution', () => {
        expect(resolveNewSessionPermissionMode({ claude: { permissionMode: 'default' } }, 'pi', false)).toBe('bypassPermissions');
        expect(resolveNewSessionPermissionMode({ pi: { permissionMode: 'default' } }, 'pi', false)).toBe('default');
        expect(resolveNewSessionPermissionMode({ pi: { permissionMode: 'bypassPermissions' } }, 'pi', true)).toBe('bypassPermissions');
        expect(resolveNewSessionPermissionMode({}, 'pi', true)).toBe('default');
    });

    it('the synced schema accepts a pi slot without a zod default (rule 1)', () => {
        const parsed = AgentDefaultOverridesSchema.parse({ pi: { modelMode: 'zai/glm-5.3' } });
        expect(parsed.pi).toEqual({ modelMode: 'zai/glm-5.3' });
        // parsing an empty object must not conjure a pi key
        expect('pi' in AgentDefaultOverridesSchema.parse({})).toBe(false);
        // the schema source carries no .default() on the per-agent slots
        const shape = AgentDefaultOverridesSchema.removeDefault().shape;
        for (const key of agentKeys) {
            expect(shape[key].safeParse(undefined).success).toBe(true);
            expect(shape[key].parse(undefined)).toBeUndefined();
        }
    });
});
