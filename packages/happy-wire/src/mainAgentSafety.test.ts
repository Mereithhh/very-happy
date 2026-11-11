import { describe, expect, it } from 'vitest';
import {
    effectiveSafetyPolicy, isLoosening, mainAgentConfigLoosening, parseMainAgentSafety, PRESET_POLICIES,
    stricterPolicy, toolNameFromToolCardKey,
} from './mainAgentSafety';

describe('B-922 main agent safety section', () => {
    it('no section = default (standard)', () => {
        expect(parseMainAgentSafety(undefined)).toEqual({ safety: { v: 1, preset: 'standard', overrides: {}, allowedTools: [] }, failedClosed: false });
    });

    it.each([
        ['not an object', 'loose'],
        ['future version', { v: 2, preset: 'loose' }],
        ['unknown preset', { v: 1, preset: 'yolo' }],
        ['unknown top-level field', { v: 1, preset: 'loose', quietHours: [] }],
        ['unknown override key', { v: 1, preset: 'loose', overrides: { network: 'allow' } }],
        ['invalid override value', { v: 1, preset: 'loose', overrides: { outbound: 'always' } }],
        ['allowedTools not an array', { v: 1, preset: 'loose', allowedTools: 'mcp__x__send' }],
    ])('fails closed to strict: %s', (_label, raw) => {
        const parsed = parseMainAgentSafety(raw);
        expect(parsed.failedClosed).toBe(true);
        expect(parsed.safety).toEqual({ v: 1, preset: 'strict', overrides: {}, allowedTools: [] });
        expect(effectiveSafetyPolicy(parsed.safety)).toEqual(PRESET_POLICIES.strict);
    });

    it('overrides sit on top of the preset; bad allowedTools items drop alone', () => {
        const { safety } = parseMainAgentSafety({ v: 1, preset: 'standard', overrides: { bash: true, dispatchExternal: 'direct' }, allowedTools: ['mcp__x__send_message', 'mcp__*__*', 'MCP__X__SEND_MESSAGE'] });
        expect(safety.allowedTools).toEqual(['mcp__x__send_message']);
        expect(effectiveSafetyPolicy(safety)).toEqual({ ...PRESET_POLICIES.standard, bash: true, dispatchExternal: 'direct' });
    });

    it('strict keeps B-916c behaviour: every tool class denied, both risk levels ask, built-ins off', () => {
        expect(PRESET_POLICIES.strict).toEqual({ production: 'deny', outbound: 'deny', thirdPartyWrite: 'deny', dispatchExternal: 'ask', dispatchProduction: 'ask', bash: false, fileEdits: false });
    });

    it('stricterPolicy takes the stricter value per item', () => {
        expect(stricterPolicy(PRESET_POLICIES.loose, { ...PRESET_POLICIES.strict, dispatchExternal: 'direct', bash: true }))
            .toEqual({ ...PRESET_POLICIES.strict, dispatchExternal: 'direct' });
    });

    it('loosening: preset, override, allowedTools added, deniedTools removed, deletion', () => {
        const strict = { v: 1, deniedTools: ['mcp__*__*archive*'], safety: { v: 1, preset: 'strict' } };
        expect(isLoosening(mainAgentConfigLoosening(strict, { ...strict, safety: { v: 1, preset: 'standard' } }))).toBe(true);
        expect(mainAgentConfigLoosening(strict, { ...strict, safety: { v: 1, preset: 'strict', overrides: { bash: true } } }).policy).toEqual(['bash']);
        expect(mainAgentConfigLoosening(strict, { ...strict, deniedTools: [] }).removedDeniedTools).toEqual(['mcp__*__*archive*']);
        expect(mainAgentConfigLoosening(strict, null).policy.length).toBeGreaterThan(0);
        const std = { v: 1, safety: { v: 1, preset: 'standard', allowedTools: ['mcp__a__get_x'] } };
        expect(mainAgentConfigLoosening(std, { v: 1, safety: { v: 1, preset: 'standard', allowedTools: ['mcp__a__get_x', 'mcp__a__send'] } }).addedAllowedTools).toEqual(['mcp__a__send']);
        // tightening is never loosening; an unknown section reads strict, so writing one is tightening
        expect(isLoosening(mainAgentConfigLoosening(std, { v: 1, safety: { v: 1, preset: 'strict' } }))).toBe(false);
        expect(isLoosening(mainAgentConfigLoosening(std, { v: 1, safety: { v: 9 } }))).toBe(false);
        expect(isLoosening(mainAgentConfigLoosening({ v: 1, safety: { v: 9 } }, std))).toBe(true);
        // no section on either side = standard both times
        expect(isLoosening(mainAgentConfigLoosening(null, { v: 1, skillRoots: ['~/s'] }))).toBe(false);
    });

    it('tool card key → tool name', () => {
        expect(toolNameFromToolCardKey('main-agent-tool:0b8c2b5e-1111-4222-8333-944445555666:mcp__x__send_message')).toBe('mcp__x__send_message');
        expect(toolNameFromToolCardKey('main-agent-tool::mcp__x__send')).toBeNull();
        expect(toolNameFromToolCardKey('main-agent-dispatch:abc')).toBeNull();
        expect(toolNameFromToolCardKey('main-agent-tool:id:mcp__*__*')).toBeNull();
    });
});
