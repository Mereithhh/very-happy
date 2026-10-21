import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './lineDiff';
import { collectSecretValues, isSecretKey, maskSecret, redactText } from './secrets';
import { editToml } from './tomlEdit';
import { editDotenv } from './dotenvEdit';

describe('secrets', () => {
    it('masks long values to 4+4 and short ones entirely', () => {
        expect(maskSecret('sk-ant-0123456789abcdef')).toBe('sk-a…cdef');
        expect(maskSecret('short-key')).toBe('••••');
    });
    it('treats credential-looking keys as secret, env-var NAMES as not', () => {
        for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'apiKey', 'experimental_bearer_token', 'Authorization', 'GEMINI_API_KEY', 'apiKeyHelper']) expect(isSecretKey(k)).toBe(true);
        for (const k of ['env_key', 'base_url', 'ANTHROPIC_BASE_URL', 'model']) expect(isSecretKey(k)).toBe(false);
    });
    it('collects nested secrets and redacts every occurrence', () => {
        const secrets = collectSecretValues({ a: { headers: { Authorization: 'Bearer abcdefghijklmnopq' } }, list: [{ apiKey: 'zzzz-1234567890-yyyy' }] });
        expect([...secrets].sort()).toEqual(['Bearer abcdefghijklmnopq', 'zzzz-1234567890-yyyy']);
        expect(redactText('x Bearer abcdefghijklmnopq y zzzz-1234567890-yyyy', secrets)).toBe('x Bear…nopq y zzzz…yyyy');
    });
});

describe('unifiedDiff', () => {
    it('emits hunks with context and counts', () => {
        const diff = unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nD\ne\nf\ng\nh\n', 'f.txt');
        expect(diff).toBe('--- f.txt\n+++ f.txt\n@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n');
    });
    it('new file diffs from /dev/null and equal texts give nothing', () => {
        expect(unifiedDiff('', 'x\n', 'n')).toBe('--- /dev/null\n+++ n\n@@ -0,0 +1,1 @@\n+x\n');
        expect(unifiedDiff('same', 'same', 'n')).toBe('');
    });
});

describe('editToml', () => {
    it('keeps an inline comment when replacing a scalar and inserts root keys before the first table', () => {
        const out = editToml('model = "a" # mine\n\n[t]\nx = 1\n', [{ table: [], key: 'model', value: 'b' }, { table: [], key: 'model_provider', value: 'p' }]);
        expect(out).toBe('model = "b" # mine\nmodel_provider = "p"\n\n[t]\nx = 1\n');
    });
    it('does not mistake text inside multi-line strings for keys or headers', () => {
        const src = 'note = """\n[fake]\nmodel = "x"\n"""\n';
        const out = editToml(src, [{ table: [], key: 'model', value: 'real' }]);
        expect(out).toBe('note = """\n[fake]\nmodel = "x"\n"""\nmodel = "real"\n');
    });
    it('escapes values so they cannot inject TOML', () => {
        const out = editToml('', [{ table: ['p'], key: 'name', value: 'x"\n[evil]\ny = "1' }]);
        expect(out).toBe('[p]\nname = "x\\"\\n[evil]\\ny = \\"1"\n');
    });
    it('removes a whole table including its sub-tables', () => {
        const out = editToml('a = 1\n\n[model_providers.x]\nname = "x"\n\n[model_providers.x.http_headers]\nX = "1"\n\n[keep]\nb = 2\n', [{ table: ['model_providers', 'x'], removeTable: true }]);
        expect(out).toBe('a = 1\n\n[keep]\nb = 2\n');
    });
    it('keeps CRLF line endings', () => {
        expect(editToml('a = 1\r\n', [{ table: [], key: 'model', value: 'm' }])).toBe('a = 1\r\nmodel = "m"\r\n');
    });
});

describe('editDotenv', () => {
    it('quotes values that need it and refuses nothing it can prove', () => {
        expect(editDotenv('A=1\n', [{ key: 'B', value: 'has space' }])).toBe('A=1\nB="has space"\n');
        expect(editDotenv('export B=old\nA=1\n', [{ key: 'B', value: null }])).toBe('A=1\n');
    });
});
