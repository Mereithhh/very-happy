import { describe, expect, it } from 'vitest';
import { AGENT_VERSION_SOURCES } from './agentVersions';
import { HARNESS_INSTALL_IDS, isHarnessInstallId } from './harnessInstall';

describe('harness install ids (B-719)', () => {
    it('accepts only the fixed enum — never a package name or command', () => {
        for (const id of HARNESS_INSTALL_IDS) expect(isHarnessInstallId(id)).toBe(true);
        for (const bad of ['@openai/codex', 'pi-acp', 'npm', 'rm -rf /', 'claude-sdk', 'opencode', '', null, 1, { id: 'pi' }]) {
            expect(isHarnessInstallId(bad)).toBe(false);
        }
    });
    it('every installable harness has a version source the machine page can show', () => {
        for (const id of HARNESS_INSTALL_IDS) expect(AGENT_VERSION_SOURCES.some((s) => s.id === id)).toBe(true);
    });
    it('pi versions come from the maintained package', () => {
        expect(AGENT_VERSION_SOURCES.find((s) => s.id === 'pi')?.package).toBe('@earendil-works/pi-coding-agent');
    });
});
