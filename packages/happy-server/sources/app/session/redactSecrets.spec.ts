import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets, redactSecretsDeep } from './redactSecrets';

// Fake token shapes are assembled at runtime so the repository secret scan
// (gitleaks) never sees a literal that looks like a live credential.
const fake = (...parts: string[]) => parts.join('');

describe('B-701 redactSecrets', () => {
    it.each([
        ['anthropic', fake('key sk-', 'ant-api03-abcdefghijklmnopqrstuvwxyz0123 here')],
        ['openai', 'OPENAI sk-proj-abcdefghijklmnopqrstuvwx12'],
        ['github classic', fake('gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789')],
        ['github fine-grained', fake('github_', 'pat_11ABCDEFG0123456789_abcdefghij')],
        ['gitlab', fake('glpat', '-abcdefghijklmnop1234')],
        ['slack', 'xoxb-1234567890-abcdefghij'],
        ['aws', 'AKIAIOSFODNN7EXAMPLE'],
        ['google', fake('AIza', 'SyA1234567890abcdefghijklmnopqrstuv')],
        ['stripe', fake('sk_', 'live_abcdefghijklmnop1234')],
        ['npm', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
        ['jwt', fake('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
    ])('masks %s tokens', (_name, input) => {
        const out = redactSecrets(input);
        expect(out).toContain(REDACTED);
        expect(out).not.toMatch(/abcdefghij|IOSFODNN7|dozjgNry/);
    });

    it('masks PEM private keys, keeping surrounding text', () => {
        const out = redactSecrets('before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter');
        expect(out).toBe(`before\n${REDACTED}\nafter`);
    });

    it('masks URL credentials but keeps user and host', () => {
        expect(redactSecrets('git remote: https://bot:s3cretpass@github.com/x/y.git'))
            .toBe(`git remote: https://bot:${REDACTED}@github.com/x/y.git`);
        expect(redactSecrets('postgres://app:hunter22@db:5432/happy')).toBe(`postgres://app:${REDACTED}@db:5432/happy`);
    });

    it('masks env / yaml / json assignments whose name says secret', () => {
        expect(redactSecrets('export API_KEY=abc123xyz')).toBe(`export API_KEY=${REDACTED}`);
        expect(redactSecrets('DB_PASSWORD="p@ssw0rd!"')).toBe(`DB_PASSWORD="${REDACTED}"`);
        expect(redactSecrets('  github_token: 0123abcd')).toBe(`  github_token: ${REDACTED}`);
        expect(redactSecrets('{"clientSecret": "very-secret-value"}')).toBe(`{"clientSecret": "${REDACTED}"}`);
        expect(redactSecrets(fake('Authorization: Bear', 'er abcdefghijklmnopqrstuvwxyz'))).toContain(`Bearer ${REDACTED}`);
    });

    it('leaves ordinary code and prose alone', () => {
        const samples = [
            'const token = getToken();',
            'function parseSecret(input: string) { return input; }',
            'PORT=3005\nNODE_ENV=production',
            'see https://github.com/Mereithhh/very-happy/pull/554',
            'the password field must not be empty',
            'sk-learn is a library',
        ];
        for (const sample of samples) expect(redactSecrets(sample)).toBe(sample);
    });

    it('is idempotent', () => {
        const once = redactSecrets(fake('API_KEY=abc123xyz gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789'));
        expect(redactSecrets(once)).toBe(once);
    });

    it('walks nested records', () => {
        const out = redactSecretsDeep({ a: ['x', { b: 'TOKEN=abcdefgh' }], n: 3, nil: null });
        expect(out).toEqual({ a: ['x', { b: `TOKEN=${REDACTED}` }], n: 3, nil: null });
    });
});
