import { describe, expect, it } from 'vitest';
import { parseInstanceConfig } from '@/app/instance/instanceConfig';
import { visibleModelChannels } from './modelChannels';

const channel = (over: Record<string, unknown> = {}) => ({
    id: 'team-gw', label: 'Team gateway', agent: 'claude', baseUrl: 'https://gw.example.com/', apiKey: '${GW_KEY}', models: ['model-a', 'model-b'],
    ...over,
});

describe('globalModelChannels config', () => {
    it('expands the key from the environment and defaults enabled/audience', () => {
        const { config, problems } = parseInstanceConfig(JSON.stringify({ globalModelChannels: [channel()] }), { GW_KEY: 'sk-test-123' });
        expect(problems).toEqual([]);
        expect(config.globalModelChannels).toEqual([{
            id: 'team-gw', enabled: true, label: 'Team gateway', agent: 'claude', baseUrl: 'https://gw.example.com', apiKey: 'sk-test-123', models: ['model-a', 'model-b'], audience: 'all',
        }]);
    });

    it('drops a broken channel by itself and never reports values (the key may be one)', () => {
        const { config, problems } = parseInstanceConfig(JSON.stringify({
            globalModelChannels: [
                channel({ id: 'ok' }),
                channel({ id: 'no-models', models: [] }),
                channel({ id: 'Bad Id!' }),
                channel({ id: 'bad-agent', agent: 'sk-live-should-not-leak' }),
                channel({ id: 'ok' }),
                channel({ id: 'missing-key', apiKey: '${UNSET_KEY}' }),
            ],
            modelFeedback: { enabled: true },
        }), { GW_KEY: 'sk-test-123' });
        expect(config.globalModelChannels.map(c => c.id)).toEqual(['ok']);
        expect(config.modelFeedback).toMatchObject({ enabled: true });
        expect(problems).toEqual([
            'unset environment variables: UNSET_KEY',
            'globalModelChannels[no-models]: dropped (invalid models)',
            'globalModelChannels[#2]: dropped (invalid id)',
            'globalModelChannels[bad-agent]: dropped (invalid agent)',
            'globalModelChannels[ok]: dropped (duplicate id)',
            'globalModelChannels[missing-key]: dropped (invalid apiKey)',
        ]);
        expect(problems.join(' ')).not.toContain('sk-');
    });

    it('a non-array section is reported and means no channels', () => {
        const { config, problems } = parseInstanceConfig(JSON.stringify({ globalModelChannels: { id: 'x' } }), {});
        expect(config.globalModelChannels).toEqual([]);
        expect(problems).toEqual(['globalModelChannels: must be an array']);
    });
});

describe('visibleModelChannels', () => {
    const { config } = parseInstanceConfig(JSON.stringify({
        globalModelChannels: [
            channel(),
            channel({ id: 'off', enabled: false }),
            channel({ id: 'few', audience: { accounts: ['acct-1'] } }),
            channel({ id: 'cx', agent: 'codex', wireApi: 'responses', contextWindows: { 'model-a': 200000 } }),
        ],
    }), { GW_KEY: 'sk-test-123' });

    it('machine tokens get enabled channels of their audience, with the key', () => {
        const res = visibleModelChannels(config, 'acct-1', 'machine');
        expect(res.channels.map(c => c.id)).toEqual(['team-gw', 'few', 'cx']);
        expect(res.channels[0]).toEqual({ id: 'team-gw', label: 'Team gateway', agent: 'claude', baseUrl: 'https://gw.example.com', models: ['model-a', 'model-b'], apiKey: 'sk-test-123' });
        expect(res.channels[2]).toMatchObject({ wireApi: 'responses', contextWindows: { 'model-a': 200000 } });
        expect(visibleModelChannels(config, 'acct-2', 'machine').channels.map(c => c.id)).toEqual(['team-gw', 'cx']);
    });

    it('human (Web) tokens never get a key', () => {
        const res = visibleModelChannels(config, 'acct-1', 'human');
        expect(res.channels).toHaveLength(3);
        expect(JSON.stringify(res)).not.toContain('sk-test-123');
    });

    it('revision is stable for the same answer and changes with any visible change', () => {
        const a = visibleModelChannels(config, 'acct-1', 'machine').revision;
        expect(visibleModelChannels(config, 'acct-1', 'machine').revision).toBe(a);
        expect(visibleModelChannels(config, 'acct-2', 'machine').revision).not.toBe(a);
        const rotated = parseInstanceConfig(JSON.stringify({ globalModelChannels: [channel(), channel({ id: 'off', enabled: false }), channel({ id: 'few', audience: { accounts: ['acct-1'] } }), channel({ id: 'cx', agent: 'codex', wireApi: 'responses', contextWindows: { 'model-a': 200000 } })] }), { GW_KEY: 'sk-rotated' }).config;
        expect(visibleModelChannels(rotated, 'acct-1', 'machine').revision).not.toBe(a);
        expect(visibleModelChannels({ globalModelChannels: [] }, 'acct-1', 'machine')).toMatchObject({ channels: [] });
    });
});
