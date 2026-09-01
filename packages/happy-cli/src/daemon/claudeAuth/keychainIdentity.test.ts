import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keychainIdentity } from './keychainIdentity';

const home = '/Users/jojo';
const deps = { home, username: () => 'jojo' };

describe('keychainIdentity (mirrors Claude Code 2.1.252)', () => {
    it('default profile', () => {
        expect(keychainIdentity({ USER: 'jojo' }, deps)).toEqual({
            service: 'Claude Code-credentials',
            account: 'jojo',
            configDir: '/Users/jojo/.claude',
            credentialsPath: '/Users/jojo/.claude/.credentials.json',
        });
    });

    it('CLAUDE_CONFIG_DIR adds a sha256 suffix and moves the file', () => {
        const dir = '/Users/jojo/.claude-work';
        const suffix = createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
        const id = keychainIdentity({ USER: 'jojo', CLAUDE_CONFIG_DIR: dir }, deps);
        expect(id.service).toBe(`Claude Code-credentials-${suffix}`);
        expect(id.credentialsPath).toBe(`${dir}/.credentials.json`);
    });

    it('CLAUDE_SECURESTORAGE_CONFIG_DIR wins over CLAUDE_CONFIG_DIR; empty value is ignored', () => {
        const a = keychainIdentity({ USER: 'jojo', CLAUDE_CONFIG_DIR: '/a', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/b' }, deps);
        expect(a.configDir).toBe('/b');
        const b = keychainIdentity({ USER: 'jojo', CLAUDE_CONFIG_DIR: '/a', CLAUDE_SECURESTORAGE_CONFIG_DIR: '  ' }, deps);
        expect(b.configDir).toBe('/a');
    });

    it('CLAUDE_CODE_OAUTH_CLIENT_ID switches to the custom-oauth service', () => {
        expect(keychainIdentity({ USER: 'jojo', CLAUDE_CODE_OAUTH_CLIENT_ID: 'x' }, deps).service)
            .toBe('Claude Code-custom-oauth-credentials');
    });

    it('USER beats os username; illegal characters fall back to claude-code-user', () => {
        expect(keychainIdentity({ USER: 'wang lu' }, deps).account).toBe('claude-code-user');
        expect(keychainIdentity({}, deps).account).toBe('jojo');
        expect(keychainIdentity({ USER: 'w.l-1_x' }, deps).account).toBe('w.l-1_x');
    });
});
