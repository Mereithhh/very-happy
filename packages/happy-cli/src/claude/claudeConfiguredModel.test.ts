import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { claudeSettingsFiles, readClaudeConfiguredModel } from './claudeConfiguredModel';

const HOME = '/home/u';
const CWD = '/work/repo';
const files = (map: Record<string, unknown>) => (path: string) => {
    if (!(path in map)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const value = map[path];
    return typeof value === 'string' ? value : JSON.stringify(value);
};
const USER = join(HOME, '.claude', 'settings.json');
const PROJECT = join(CWD, '.claude', 'settings.json');
const LOCAL = join(CWD, '.claude', 'settings.local.json');

describe('readClaudeConfiguredModel (B-883: known at wrapper start)', () => {
    it('user settings model (dev-sg: opus[1m])', () => {
        expect(readClaudeConfiguredModel({}, CWD, files({ [USER]: { model: 'opus[1m]' } }), HOME)).toBe('opus[1m]');
    });

    it('nothing configured → null (follow latest sends the 1M default)', () => {
        expect(readClaudeConfiguredModel({}, CWD, files({}), HOME)).toBeNull();
        expect(readClaudeConfiguredModel({}, CWD, files({ [USER]: { permissions: {} } }), HOME)).toBeNull();
    });

    it('local > project > user, as Claude Code merges them', () => {
        const read = files({ [USER]: { model: 'opus[1m]' }, [PROJECT]: { model: 'claude-sonnet-5' }, [LOCAL]: { model: 'sonnet' } });
        expect(readClaudeConfiguredModel({}, CWD, read, HOME)).toBe('sonnet');
        expect(readClaudeConfiguredModel({}, CWD, files({ [USER]: { model: 'opus[1m]' }, [PROJECT]: { model: 'claude-sonnet-5' } }), HOME)).toBe('claude-sonnet-5');
    });

    it('ANTHROPIC_MODEL: settings env > process env > settings model', () => {
        expect(readClaudeConfiguredModel({ ANTHROPIC_MODEL: 'claude-opus-5-5[1m]' }, CWD, files({ [USER]: { model: 'sonnet' } }), HOME)).toBe('claude-opus-5-5[1m]');
        expect(readClaudeConfiguredModel({ ANTHROPIC_MODEL: 'claude-opus-5-5[1m]' }, CWD, files({ [USER]: { env: { ANTHROPIC_MODEL: 'claude-haiku-5-5' } } }), HOME)).toBe('claude-haiku-5-5');
    });

    it('CLAUDE_CONFIG_DIR moves the user file; a broken file is skipped', () => {
        expect(claudeSettingsFiles({ CLAUDE_CONFIG_DIR: '/cfg' }, CWD, HOME)[0]).toBe('/cfg/settings.json');
        expect(readClaudeConfiguredModel({ CLAUDE_CONFIG_DIR: '/cfg' }, CWD, files({ '/cfg/settings.json': { model: 'opus' }, [LOCAL]: '{ not json' }), HOME)).toBe('opus');
    });
});
