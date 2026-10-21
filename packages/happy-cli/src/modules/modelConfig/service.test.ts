import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelConfigService } from './service';
import type { ModelConfigApplyResult } from './types';

// Obviously fake, assembled at runtime so secret scanners don't flag the fixture.
const SECRET = ['sk', 'fixture', 'not', 'a', 'real', 'key', '0000'].join('-');

let root: string;
let home: string;
let vh: string;
let changed: string[];

function service(env: NodeJS.ProcessEnv = {}) {
    return new ModelConfigService({ home, env, happyHomeDir: vh, isInstalled: () => true, onChanged: h => changed.push(h), now: () => 1_792_000_000_000 });
}

async function applyForReal(svc: ModelConfigService, patch: unknown): Promise<ModelConfigApplyResult> {
    const preview = await svc.apply({ patch });
    return svc.apply({ patch, baseHash: preview.baseHash, dryRun: false });
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vh-model-config-'));
    home = join(root, 'home');
    vh = join(root, 'vh');
    mkdirSync(home, { recursive: true });
    changed = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('claude settings.json', () => {
    const path = () => join(home, '.claude', 'settings.json');
    const existing = {
        permissions: { allow: ['Bash(ls:*)'] },
        env: { OTHER_VAR: '1', ANTHROPIC_API_KEY: 'old-key-that-is-long-enough' },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        model: 'opus',
    };

    it('merges only the owned keys and keeps everything else in order', async () => {
        mkdirSync(join(home, '.claude'));
        writeFileSync(path(), JSON.stringify(existing, null, 4) + '\n', { mode: 0o640 });
        const svc = service();
        const result = await applyForReal(svc, {
            harness: 'claude', baseUrl: 'http://127.0.0.1:5341', authHeader: 'bearer',
            apiKey: { mode: 'literal', value: SECRET }, model: 'glm-5.3', sonnetModel: 'glm-5.3', pickerModels: ['glm-5.3', 'kimi-k3'],
        });
        expect(result.changed).toBe(true);
        const written = JSON.parse(readFileSync(path(), 'utf8'));
        expect(Object.keys(written)).toEqual(['permissions', 'env', 'hooks', 'model', 'modelPicker']);
        expect(written.permissions).toEqual(existing.permissions);
        expect(written.hooks).toEqual(existing.hooks);
        expect(written.env).toEqual({ OTHER_VAR: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:5341', ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3' });
        expect(written.model).toBe('glm-5.3');
        expect(written.modelPicker).toEqual({ options: [{ model: 'glm-5.3' }, { model: 'kimi-k3' }] });
        // indentation + mode preserved
        expect(readFileSync(path(), 'utf8')).toMatch(/^\{\n {4}"permissions"/);
        expect(statSync(path()).mode & 0o777).toBe(0o640);
        expect(result.config?.current.apiKey).toEqual({ mode: 'literal', masked: 'sk-f…0000' });
        expect(result.config?.pickerModels).toEqual(['glm-5.3', 'kimi-k3']);
        expect(changed).toEqual(['claude']);
    });

    it('dry run writes nothing and masks every secret in the diff', async () => {
        mkdirSync(join(home, '.claude'));
        writeFileSync(path(), JSON.stringify(existing));
        const before = readFileSync(path(), 'utf8');
        const preview = await service().apply({ patch: { harness: 'claude', apiKey: { mode: 'literal', value: SECRET } } });
        expect(preview.dryRun).toBe(true);
        expect(readFileSync(path(), 'utf8')).toBe(before);
        const diff = preview.files.map(f => f.diff).join('\n');
        // the file already used x-api-key (ANTHROPIC_API_KEY); keep that header, replace the value
        expect(diff).toContain('-{"permissions"');
        expect(diff).toContain('"ANTHROPIC_API_KEY":"sk-f…0000"');
        // a one-line file stays one line
        expect(preview.files[0].diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'))).toHaveLength(1);
        expect(diff).not.toContain(SECRET);
        expect(diff).not.toContain('old-key-that-is-long-enough');
        expect(existsSync(vh)).toBe(false);
    });

    it('env-reference mode writes an apiKeyHelper and reports presence, never a value', async () => {
        const svc = service({ MY_GATEWAY_KEY: 'whatever' });
        const result = await applyForReal(svc, { harness: 'claude', baseUrl: 'https://gw.example.com', apiKey: { mode: 'env', name: 'MY_GATEWAY_KEY' } });
        const written = JSON.parse(readFileSync(path(), 'utf8'));
        expect(written.apiKeyHelper).toBe('printf %s "$MY_GATEWAY_KEY"');
        expect(written.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(result.config?.current.apiKey).toEqual({ mode: 'env', envName: 'MY_GATEWAY_KEY', envPresent: true });
        // a new file is private
        expect(statSync(path()).mode & 0o777).toBe(0o600);
    });

    it('refuses settings.json with comments instead of dropping them', async () => {
        mkdirSync(join(home, '.claude'));
        writeFileSync(path(), '{\n  // mine\n  "model": "opus"\n}\n');
        await expect(service().apply({ patch: { harness: 'claude', model: 'x' } })).rejects.toMatchObject({ code: 'json-has-comments' });
        const view = (await service().read({ harness: 'claude' })).harnesses[0];
        expect(view.files[0].error?.code).toBe('json-has-comments');
    });

    it('appends new ids to an existing availableModels allowlist', async () => {
        mkdirSync(join(home, '.claude'));
        writeFileSync(path(), JSON.stringify({ availableModels: ['opus'] }));
        await applyForReal(service(), { harness: 'claude', model: 'glm-5.3' });
        expect(JSON.parse(readFileSync(path(), 'utf8')).availableModels).toEqual(['opus', 'glm-5.3']);
    });
});

describe('codex config.toml', () => {
    const path = () => join(home, '.codex', 'config.toml');
    const original = [
        '# personal codex config',
        'model = "gpt-5.5" # keep this comment',
        'approval_policy = "never"',
        '',
        '[mcp_servers.docs]',
        'command = "docs-mcp"',
        'args = [',
        '  "[not-a-header]",',
        ']',
        '',
        '[model_providers.other]',
        'name = "Other"',
        'base_url = "https://other.example.com/v1"',
        '',
    ].join('\n');

    it('adds a provider, keeps comments and unrelated tables byte-for-byte', async () => {
        mkdirSync(join(home, '.codex'));
        writeFileSync(path(), original);
        const result = await applyForReal(service({ MOCK_KEY: 'x' }), {
            harness: 'codex', providerId: 'mock', providerName: 'Mock', baseUrl: 'http://127.0.0.1:5342/v1',
            apiKey: { mode: 'env', name: 'MOCK_KEY' }, model: 'mock-model', activate: true,
        });
        const text = readFileSync(path(), 'utf8');
        expect(text).toContain('# personal codex config\nmodel = "mock-model" # keep this comment\napproval_policy = "never"\nmodel_provider = "mock"\n');
        expect(text).toContain('[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = [\n  "[not-a-header]",\n]\n');
        expect(text).toContain('[model_providers.other]\nname = "Other"\nbase_url = "https://other.example.com/v1"\n');
        expect(text).toContain('[model_providers.mock]\nname = "Mock"\nbase_url = "http://127.0.0.1:5342/v1"\nwire_api = "responses"\nenv_key = "MOCK_KEY"\n');
        expect(result.config?.current).toMatchObject({ providerId: 'mock', active: true, model: 'mock-model', apiKey: { mode: 'env', envName: 'MOCK_KEY', envPresent: true } });
        expect(result.config?.providers).toEqual(['other', 'mock']);
    });

    it('literal key goes to experimental_bearer_token and is masked in the diff', async () => {
        const preview = await service().apply({ patch: { harness: 'codex', providerId: 'gw', baseUrl: 'https://gw.example.com/v1', apiKey: { mode: 'literal', value: SECRET } } });
        expect(preview.files[0].created).toBe(true);
        expect(preview.files[0].diff).toContain('experimental_bearer_token = "sk-f…0000"');
        expect(preview.files[0].diff).not.toContain(SECRET);
    });

    it('rejects reserved provider ids, missing base URL, and invalid TOML', async () => {
        await expect(service().apply({ patch: { harness: 'codex', providerId: 'openai', baseUrl: 'https://x.example.com/v1' } })).rejects.toMatchObject({ code: 'invalid-input' });
        await expect(service().apply({ patch: { harness: 'codex', providerId: 'new' } })).rejects.toMatchObject({ code: 'invalid-input' });
        mkdirSync(join(home, '.codex'));
        writeFileSync(path(), 'model = = "x"\n');
        await expect(service().apply({ patch: { harness: 'codex', providerId: 'p', baseUrl: 'https://x.example.com/v1' } })).rejects.toMatchObject({ code: 'invalid-toml' });
    });

    it('refuses an edit that would collide with a dotted-key definition', async () => {
        mkdirSync(join(home, '.codex'));
        writeFileSync(path(), 'model_providers.mock.name = "x"\n');
        await expect(service().apply({ patch: { harness: 'codex', providerId: 'mock', baseUrl: 'https://x.example.com/v1' } })).rejects.toMatchObject({ code: 'unsafe-edit' });
        expect(readFileSync(path(), 'utf8')).toBe('model_providers.mock.name = "x"\n');
    });
});

describe('safe writes', () => {
    it('backs up before writing and restore brings the original back (with its own backup)', async () => {
        mkdirSync(join(home, '.codex'));
        const path = join(home, '.codex', 'config.toml');
        writeFileSync(path, 'model = "a"\n');
        const svc = service();
        const applied = await applyForReal(svc, { harness: 'codex', providerId: 'p', baseUrl: 'https://x.example.com/v1', model: 'b' });
        expect(applied.backup?.reason).toBe('before-apply');
        const view = (await svc.read({ harness: 'codex' })).harnesses[0];
        expect(view.backups.map(b => b.id)).toEqual([applied.backup!.id]);
        const preview = await svc.restore({ harness: 'codex', backupId: applied.backup!.id });
        expect(preview.files[0].diff).toContain('-model = "b"');
        const restored = await svc.restore({ harness: 'codex', backupId: applied.backup!.id, baseHash: preview.baseHash, dryRun: false });
        expect(readFileSync(path, 'utf8')).toBe('model = "a"\n');
        expect(restored.backup?.reason).toBe('before-restore');
        const backupDir = join(vh, 'model-config-backups', 'codex');
        expect(statSync(backupDir).mode & 0o777).toBe(0o700);
        expect(statSync(join(backupDir, applied.backup!.id, 'f0')).mode & 0o777).toBe(0o600);
    });

    it('restoring a backup of a file that did not exist deletes it', async () => {
        const svc = service();
        const applied = await applyForReal(svc, { harness: 'claude', model: 'x' });
        const path = join(home, '.claude', 'settings.json');
        expect(existsSync(path)).toBe(true);
        const preview = await svc.restore({ harness: 'claude', backupId: applied.backup!.id });
        expect(preview.files[0].deleted).toBe(true);
        await svc.restore({ harness: 'claude', backupId: applied.backup!.id, baseHash: preview.baseHash, dryRun: false });
        expect(existsSync(path)).toBe(false);
    });

    it('refuses to apply when the file changed after the preview', async () => {
        mkdirSync(join(home, '.claude'));
        const path = join(home, '.claude', 'settings.json');
        writeFileSync(path, '{}');
        const svc = service();
        const patch = { harness: 'claude', model: 'x' };
        const preview = await svc.apply({ patch });
        writeFileSync(path, '{"model":"someone-else"}');
        await expect(svc.apply({ patch, baseHash: preview.baseHash, dryRun: false })).rejects.toMatchObject({ code: 'conflict' });
        expect(readFileSync(path, 'utf8')).toBe('{"model":"someone-else"}');
    });

    it('writes through a symlink, leaves no temp file, and keeps the link', async () => {
        const real = join(root, 'dotfiles', 'settings.json');
        mkdirSync(join(root, 'dotfiles'));
        writeFileSync(real, '{"model":"opus"}\n');
        mkdirSync(join(home, '.claude'));
        symlinkSync(real, join(home, '.claude', 'settings.json'));
        await applyForReal(service(), { harness: 'claude', model: 'glm' });
        expect(lstatSync(join(home, '.claude', 'settings.json')).isSymbolicLink()).toBe(true);
        expect(JSON.parse(readFileSync(real, 'utf8')).model).toBe('glm');
        expect(readdirSync(join(root, 'dotfiles'))).toEqual(['settings.json']);
    });

    it('a failed write leaves the original intact and no temp file behind', async () => {
        if (process.getuid?.() === 0) return; // root ignores directory permissions
        mkdirSync(join(home, '.claude'));
        const path = join(home, '.claude', 'settings.json');
        writeFileSync(path, '{"model":"opus"}');
        const svc = service();
        const preview = await svc.apply({ patch: { harness: 'claude', model: 'glm' } });
        chmodSync(join(home, '.claude'), 0o500);
        try {
            await expect(svc.apply({ patch: { harness: 'claude', model: 'glm' }, baseHash: preview.baseHash, dryRun: false })).rejects.toBeTruthy();
        } finally {
            chmodSync(join(home, '.claude'), 0o700);
        }
        expect(readFileSync(path, 'utf8')).toBe('{"model":"opus"}');
        expect(readdirSync(join(home, '.claude'))).toEqual(['settings.json']);
    });

    it('the audit log records key names and the key mode, never the key', async () => {
        await applyForReal(service(), { harness: 'claude', baseUrl: 'https://gw.example.com', apiKey: { mode: 'literal', value: SECRET } });
        const audit = readFileSync(join(vh, 'model-config-audit.jsonl'), 'utf8');
        expect(audit).not.toContain(SECRET);
        const record = JSON.parse(audit.trim());
        expect(record).toMatchObject({ action: 'apply', harness: 'claude', apiKeyMode: 'literal' });
        expect(record.keys).toEqual(expect.arrayContaining(['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_AUTH_TOKEN']));
    });

    it('an unchanged patch is a no-op (no backup, no write)', async () => {
        mkdirSync(join(home, '.claude'));
        writeFileSync(join(home, '.claude', 'settings.json'), '{"model":"glm"}');
        const result = await applyForReal(service(), { harness: 'claude', model: 'glm' });
        expect(result.changed).toBe(false);
        expect(existsSync(join(vh, 'model-config-backups'))).toBe(false);
    });
});

describe('invalid input', () => {
    it.each([
        [{ harness: 'nope' }, 'invalid-harness'],
        [{ harness: 'claude', baseUrl: 'ftp://x' }, 'invalid-input'],
        [{ harness: 'claude', baseUrl: 'https://user:pw@x.example.com' }, 'invalid-input'],
        [{ harness: 'claude', model: 'bad model; rm -rf' }, 'invalid-input'],
        [{ harness: 'claude', apiKey: { mode: 'literal', value: 'two\nlines' } }, 'invalid-input'],
        [{ harness: 'claude', apiKey: { mode: 'env', name: 'X; rm' } }, 'invalid-input'],
        [{ harness: 'claude', authHeader: 'basic' }, 'invalid-input'],
        [{ harness: 'gemini', apiKey: { mode: 'env', name: 'GEMINI_API_KEY' } }, 'invalid-input'],
        [{ harness: 'pi', providerId: 'p', baseUrl: 'https://x.example.com/v1', apiKey: { mode: 'literal', value: '!cat ~/.ssh/id_rsa' } }, 'invalid-input'],
        [{ harness: 'pi', providerId: 'p', baseUrl: 'https://x.example.com/v1', api: 'made-up' }, 'invalid-input'],
        [{ harness: 'pi', providerId: '../x', baseUrl: 'https://x.example.com/v1' }, 'invalid-input'],
        [{ harness: 'pi', providerId: 'p', baseUrl: 'https://x.example.com/v1', models: ['m'], contextWindows: { m: 1.5 } }, 'invalid-input'],
        [{ harness: 'pi', providerId: 'p', baseUrl: 'https://x.example.com/v1', models: ['m'], contextWindows: { m: 10 } }, 'invalid-input'],
        [{ harness: 'pi', providerId: 'p', baseUrl: 'https://x.example.com/v1', models: ['m'], contextWindows: { other: 200000 } }, 'invalid-input'],
    ])('%j → %s', async (patch, code) => {
        await expect(service().apply({ patch })).rejects.toMatchObject({ code });
    });

    it('rejects a backup id that tries to escape the backup dir', async () => {
        await expect(service().restore({ harness: 'claude', backupId: '../../etc' })).rejects.toMatchObject({ code: 'invalid-backup' });
    });
});

describe('pi models.json + settings.json', () => {
    it('writes ${NAME} for env mode, keeps extra model fields, and sets the default', async () => {
        const dir = join(home, '.pi', 'agent');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mine: { baseUrl: 'https://m.example.com/v1', api: 'openai-completions', apiKey: '!rbw get x', models: [{ id: 'a', contextWindow: 64000 }] } } }, null, 2));
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', defaultProvider: 'mine', defaultModel: 'a' }, null, 2));
        const result = await applyForReal(service({ GW_KEY: '1' }), { harness: 'pi', providerId: 'gw', baseUrl: 'http://127.0.0.1:5343/v1', apiKey: { mode: 'env', name: 'GW_KEY' }, models: ['m1', 'm2'], activate: true });
        const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
        expect(models.providers.mine.apiKey).toBe('!rbw get x');
        expect(models.providers.gw).toEqual({ baseUrl: 'http://127.0.0.1:5343/v1', api: 'openai-completions', apiKey: '${GW_KEY}', models: [{ id: 'm1' }, { id: 'm2' }] });
        expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', defaultProvider: 'gw', defaultModel: 'm1' });
        expect(result.config?.pickerModels).toEqual(['mine/a', 'gw/m1', 'gw/m2']);
        expect(result.backup?.files).toHaveLength(2);
        // editing the existing provider's model list keeps its per-model fields
        await applyForReal(service(), { harness: 'pi', providerId: 'mine', models: ['a', 'b'] });
        expect(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')).providers.mine.models).toEqual([{ id: 'a', contextWindow: 64000 }, { id: 'b' }]);
        const view = (await service().read({ harness: 'pi', providerId: 'mine' })).harnesses[0];
        expect(view.current.apiKey).toEqual({ mode: 'command' });
        expect(view.current.contextWindows).toEqual({ a: 64000 });
    });

    // B-727: without contextWindow pi assumes 128000 — the form can now write the real one.
    it('sets and removes per-model contextWindow, keeping other fields', async () => {
        const dir = join(home, '.pi', 'agent');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { gw: { baseUrl: 'https://gw.example.com/v1', api: 'openai-completions', apiKey: '${GW}', models: [{ id: 'a', maxTokens: 8000, contextWindow: 64000 }, { id: 'b' }] } } }, null, 2));
        await applyForReal(service(), { harness: 'pi', providerId: 'gw', models: ['a', 'b', 'c'], contextWindows: { a: null, b: 1_000_000, c: 262_144 } });
        expect(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')).providers.gw.models).toEqual([{ id: 'a', maxTokens: 8000 }, { id: 'b', contextWindow: 1_000_000 }, { id: 'c', contextWindow: 262_144 }]);
        const view = (await service().read({ harness: 'pi', providerId: 'gw' })).harnesses[0];
        expect(view.current.contextWindows).toEqual({ b: 1_000_000, c: 262_144 });
    });
});

describe('gemini .env + settings.json', () => {
    it('edits .env lines in place and keeps comments and other variables', async () => {
        const dir = join(home, '.gemini');
        mkdirSync(dir);
        writeFileSync(join(dir, '.env'), '# my env\nDEBUG=1\nGEMINI_API_KEY=old-value-long-enough-xx\n');
        const result = await applyForReal(service(), { harness: 'gemini', baseUrl: 'http://localhost:5344', apiKey: { mode: 'literal', value: SECRET }, model: 'gemini-3-flash-preview' });
        expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`# my env\nDEBUG=1\nGEMINI_API_KEY=${SECRET}\nGOOGLE_GEMINI_BASE_URL=http://localhost:5344\n`);
        expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ model: { name: 'gemini-3-flash-preview' } });
        expect(result.files.map(f => f.diff).join('')).not.toContain(SECRET);
        expect(result.files.map(f => f.diff).join('')).not.toContain('old-value-long-enough-xx');
    });
});

describe('read', () => {
    it('reports every harness, missing files as not existing', async () => {
        const result = await service().read();
        expect(result.version).toBe(1);
        expect(result.harnesses.map(h => h.harness)).toEqual(['claude', 'codex', 'gemini', 'pi']);
        expect(result.harnesses.every(h => h.files.every(f => !f.exists && !f.error))).toBe(true);
    });

    it('never returns a literal secret', async () => {
        mkdirSync(join(home, '.claude'));
        writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SECRET, OPENAI_API_KEY: SECRET } }));
        const text = JSON.stringify(await service().read());
        expect(text).not.toContain(SECRET);
    });
});
