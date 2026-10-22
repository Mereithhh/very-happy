import { describe, expect, it } from 'vitest';
import { MAX_REDACT_INPUT, REDACTED, redactSecrets, redactSecretsDeep } from './redactSecrets';

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

    it('matches Bearer case-insensitively', () => {
        expect(redactSecrets(fake('authorization: bear', 'er abcdefghijklmnopqrstuvwxyz'))).toContain(REDACTED);
        expect(redactSecrets(fake('AUTHORIZATION: BEAR', 'ER abcdefghijklmnopqrstuvwxyz'))).toContain(REDACTED);
    });

    it('caps a single string before masking', () => {
        const out = redactSecrets('x'.repeat(MAX_REDACT_INPUT * 3));
        expect(out.length).toBeLessThan(MAX_REDACT_INPUT + 32);
        expect(out.endsWith('[truncated]')).toBe(true);
    });

    // Security review (ReDoS): these inputs took 2-25 s per string with the
    // unbounded `\b[A-Za-z0-9_.-]*` prefixes. 200 adversarial 80 KB strings —
    // one link page — must each finish well under 50 ms.
    it('stays linear on adversarial input (200 × 80 KB, < 50 ms each)', () => {
        const rand = (n: number) => { let s = ''; const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; for (let i = 0; i < n; i++) s += a[(i * 7919 + (i >> 3) * 104729) % 64]; return s; };
        const size = 80 * 1024;
        const shapes = [
            'a-'.repeat(size / 2),
            rand(size),
            'TOKEN='.repeat(size / 6),
            'x://' + 'a'.repeat(size - 10) + ':',
            'https://' + 'a:'.repeat(size / 2),
            '-----BEGIN RSA PRIVATE KEY-----'.repeat(size / 31),
            '"secret": "'.repeat(size / 11),
            'eyJ' + 'a'.repeat(size / 2) + '.' + 'b'.repeat(size / 2 - 10),
            'Bearer '.repeat(size / 7),
            '_TOKEN_'.repeat(size / 7) + '=',
            // Re-review: many "eyJ" starts inside one base64url run (was ~270 ms per 32 KB).
            'eyJ-'.repeat(size / 4),
            ('eyJ' + 'a'.repeat(20) + '.').repeat(size / 24),
            'a://b:'.repeat(size / 6),
        ];
        // Each input's cost is the best of 3 runs, so a GC pause or a busy CI
        // neighbour does not read as a regex blow-up (a real ReDoS is 100x over).
        for (const shape of shapes) redactSecrets(shape); // warm the JIT: measure the algorithm, not compilation
        let worst = 0;
        for (let i = 0; i < 200; i++) {
            const input = shapes[i % shapes.length];
            let best = Infinity;
            for (let r = 0; r < 3; r++) {
                const t0 = performance.now();
                redactSecrets(input);
                best = Math.min(best, performance.now() - t0);
            }
            worst = Math.max(worst, best);
        }
        expect(worst).toBeLessThan(50);
    });

    // Re-review #3: a secret that straddles the 32 KB cut must not leak its front half.
    it('never exposes the head of a secret that straddles the length cap', () => {
        const cases: Array<[string, string]> = [
            ['quoted password', fake('"pass', 'word": "Hunter2Hunter2Zebra"')],
            ['url credential', fake('https://deploy:', 'SuperSecretPw123@db.internal/x')],
            ['bearer', fake('Authorization: Bear', 'er QwErTyUiOpAsDfGhJkLzXcVbNm123456')],
            ['anthropic', fake('sk-', 'ant-api03-QwErTyUiOpAsDfGhJkLz0123')],
            ['github', fake('gh', 'p_QwErTyUiOpAsDfGhJkLzXcVbNm0123456789')],
        ];
        const secretPart = (c: string) => c.replace(/^.*?(Hunter2|SuperSecret|QwErTy|sk-ant|ghp_)/, '$1');
        for (const [name, secret] of cases) {
            for (const offset of [2, 6, 12]) {
                const filler = 'x '.repeat(Math.floor((MAX_REDACT_INPUT - offset) / 2));
                const out = redactSecrets(filler + secret + ' tail');
                const value = secretPart(secret);
                for (let n = 4; n <= value.length; n++) expect(out, `${name} @${offset} leaks ${value.slice(0, n)}`).not.toContain(value.slice(0, n));
            }
        }
    });

    // B-745: `env` / `.env` dumps from tool output now reach the mask; more secret NAMES.
    it('masks AUTH / BEARER / JWT / signing, encryption, master and HMAC key assignments; AUTHOR is not a secret', () => {
        const value = ['abcd', '1234', 'efgh'].join('');
        const env = ['NPM_AUTH', 'BEARER_VALUE', 'SUPABASE_JWT', 'SIGNING_KEY', 'ENCRYPTION_KEY', 'MASTER_KEY', 'WEBHOOK_HMAC'].map((name) => `${name}=${value}`);
        for (const line of env) expect(redactSecrets(line), line).toBe(line.replace(/=.*/, `=${REDACTED}`));
        expect(redactSecrets('GIT_AUTHOR_NAME=alice-builder\nPORT=3005')).toBe('GIT_AUTHOR_NAME=alice-builder\nPORT=3005');
    });
});
