import { describe, expect, it } from 'vitest';
import { AccountSettingsSchema, MACHINE_SETTINGS_WRITABLE_KEYS, MachineSettingsWritableSchema } from './index';

describe('account settings schema (shared by Web and CLI, B-920)', () => {
    it('injects nothing into a partial parse except the two historical defaults (AGENTS rule 1)', () => {
        const parsed = AccountSettingsSchema.partial().parse({});
        expect(Object.keys(parsed).filter((key) => (parsed as Record<string, unknown>)[key] !== undefined).sort()).toEqual(['agentDefaultOverrides', 'schemaVersion']);
    });

    it('keeps unknown agent keys inside agentDefaultOverrides', () => {
        const parsed = AccountSettingsSchema.partial().parse({ agentDefaultOverrides: { claude: { modelMode: 'opus', future: 1 }, newAgent: { modelMode: 'x' } } });
        expect(parsed.agentDefaultOverrides).toEqual({ claude: { modelMode: 'opus', future: 1 }, newAgent: { modelMode: 'x' } });
    });
});

describe('machine settings writable schema', () => {
    it('never lists the keys the CLI must not write', () => {
        for (const key of ['todoProvider', 'webPanels', 'machineId', 'machineIdConfirmedByServer', 'boardLlm']) expect(MACHINE_SETTINGS_WRITABLE_KEYS).not.toContain(key);
        expect(MachineSettingsWritableSchema.strict().safeParse({ todoProvider: { command: 'sh' } }).success).toBe(false);
    });
});
