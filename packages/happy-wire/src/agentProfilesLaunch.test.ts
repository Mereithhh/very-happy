import { describe, expect, it } from 'vitest';
import { agentProfileUnavailableReason, AutomationActionSchema, ProjectDefaultsSchema, projectAgentProfilesFor, resolveLaunchAgentProfile, TeamActionSchema, TeamLaunchSchema } from './index';

describe('B-850d resolveLaunchAgentProfile', () => {
    const project = [
        { agent: 'claude', machineId: 'm1', id: 'org-a', label: 'Org A' },
        { agent: 'codex', machineId: 'm1', id: null },
        { agent: 'claude', machineId: 'm2', id: 'org-b' },
    ];

    it('explicit beats the project default; null is the machine login', () => {
        expect(resolveLaunchAgentProfile({ explicit: { id: 'x' }, project, agent: 'claude', machineId: 'm1' })).toEqual({ agentProfileId: 'x', source: 'explicit', effective: 'x' });
        expect(resolveLaunchAgentProfile({ explicit: null, project, agent: 'claude', machineId: 'm1' })).toEqual({ agentProfileId: null, source: 'explicit', effective: null });
    });

    it('project default only for the same agent on the same machine', () => {
        expect(resolveLaunchAgentProfile({ project, agent: 'claude', machineId: 'm1' })).toEqual({ agentProfileId: 'org-a', source: 'project', effective: 'org-a' });
        expect(resolveLaunchAgentProfile({ project, agent: 'claude', machineId: 'm2' })).toEqual({ agentProfileId: 'org-b', source: 'project', effective: 'org-b' });
        expect(resolveLaunchAgentProfile({ project, agent: 'codex', machineId: 'm1' })).toEqual({ agentProfileId: null, source: 'project', effective: null });
    });

    it('nothing chosen → undefined (the daemon applies the machine default, else the machine login)', () => {
        expect(resolveLaunchAgentProfile({ project, agent: 'codex', machineId: 'm2' })).toEqual({ agentProfileId: undefined, source: 'machine', effective: undefined });
        expect(resolveLaunchAgentProfile({ agent: 'claude', machineId: 'm1' })).toEqual({ agentProfileId: undefined, source: 'machine', effective: undefined });
    });

    it('with the machine defaults known (Web): machine default · X, or machine login', () => {
        expect(resolveLaunchAgentProfile({ agent: 'claude', machineId: 'm9', machineDefaults: { claude: 'dflt' } })).toEqual({ agentProfileId: undefined, source: 'machine', effective: 'dflt' });
        expect(resolveLaunchAgentProfile({ agent: 'codex', machineId: 'm9', machineDefaults: { claude: 'dflt' } })).toEqual({ agentProfileId: undefined, source: 'machine-login', effective: null });
        // The project still wins over the machine default.
        expect(resolveLaunchAgentProfile({ project, agent: 'claude', machineId: 'm1', machineDefaults: { claude: 'dflt' } }).source).toBe('project');
    });

    it('projectAgentProfilesFor keeps one machine', () => {
        expect(projectAgentProfilesFor(project, 'm2').map((e) => e.id)).toEqual(['org-b']);
        expect(projectAgentProfilesFor(null, 'm1')).toEqual([]);
    });

    it('agentProfileUnavailableReason parses daemon spawn errors', () => {
        expect(agentProfileUnavailableReason('agent-profile-unavailable:expired: account "A"')).toBe('expired');
        expect(agentProfileUnavailableReason('agent-profile-unavailable:missing-secret: x')).toBe('missing-secret');
        expect(agentProfileUnavailableReason('spawn failed')).toBeNull();
    });
});

describe('B-850d schemas are additive', () => {
    it('automation spawn action keeps agentProfile (ref or null); older shapes still parse', () => {
        const base = { kind: 'spawn', agent: 'claude', directory: '/w', prompt: 'p' } as const;
        expect(AutomationActionSchema.parse({ ...base, agentProfile: { id: 'org-a', label: 'Org A' } })).toMatchObject({ agentProfile: { id: 'org-a' } });
        expect(AutomationActionSchema.parse({ ...base, agentProfile: null })).toMatchObject({ agentProfile: null });
        expect('agentProfile' in AutomationActionSchema.parse(base)).toBe(false);
        expect(() => AutomationActionSchema.parse({ ...base, agentProfile: { id: '' } })).toThrow();
    });

    it('teams: launch / delegate / set-bot-account carry it', () => {
        expect(TeamLaunchSchema.parse({ goal: 'g', directory: '/w', assistant: 'claude', agentProfile: { id: 'a' } }).agentProfile).toEqual({ id: 'a' });
        expect(TeamActionSchema.parse({ type: 'delegate', goal: 'g', acceptance: ['a'], agentProfile: null })).toMatchObject({ agentProfile: null });
        expect(TeamActionSchema.parse({ type: 'set-bot-account', botId: 'b', agentProfile: { id: 'a' } })).toMatchObject({ type: 'set-bot-account' });
        expect(TeamActionSchema.parse({ type: 'set-bot-account', botId: 'b' })).toEqual({ type: 'set-bot-account', botId: 'b' });
    });

    it('project defaults: agentProfiles entries', () => {
        expect(ProjectDefaultsSchema.parse({ agentProfiles: [{ agent: 'claude', machineId: 'm', id: null }] }).agentProfiles).toHaveLength(1);
        expect(ProjectDefaultsSchema.parse({ agent: 'claude' }).agentProfiles).toBeUndefined();
    });
});
