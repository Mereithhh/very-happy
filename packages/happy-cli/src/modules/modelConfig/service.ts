/**
 * B-688 model-config service (spec specs/2026-10-custom-models.md).
 *
 * read    → masked view of every harness's config on this machine.
 * apply   → plan a patch; `dryRun` returns the masked diff (the web preview),
 *           a real apply re-plans against the CURRENT files, refuses when they
 *           no longer hash to the previewed `baseHash`, backs every touched
 *           file up, then writes each atomically.
 * restore → same flow with a backup's contents as the target.
 *
 * Writes are serialized per daemon. Nothing here logs or returns a secret:
 * diffs are redacted with every secret found in the old file, the new file
 * and the patch; the audit line records key NAMES and the key's mode only.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, BackupStore, ModelConfigError, readConfigFile, sha256, type BackupFile, type ConfigFileState } from './fileStore';
import { unifiedDiff } from './lineDiff';
import { redactText } from './secrets';
import { claudeAdapter } from './harnesses/claude';
import { codexAdapter } from './harnesses/codex';
import { geminiAdapter } from './harnesses/gemini';
import { piAdapter } from './harnesses/pi';
import {
    HARNESS_IDS, MODEL_CONFIG_CAPABILITY_VERSION,
    type FileDiff, type FileSet, type HarnessAdapter, type HarnessConfigView, type HarnessContext, type HarnessId,
    type ModelConfigApplyResult, type ModelConfigPatch, type ModelConfigReadResult,
} from './types';

export const ADAPTERS: Record<HarnessId, HarnessAdapter> = { claude: claudeAdapter, codex: codexAdapter, gemini: geminiAdapter, pi: piAdapter };

export interface ModelConfigServiceOptions {
    /** The home the harnesses resolve `~` against (the daemon user's). */
    home: string;
    /** The daemon's environment: harness dir overrides + env-reference presence. */
    env: NodeJS.ProcessEnv;
    /** Very Happy home; backups and the audit log live under it. */
    happyHomeDir: string;
    isInstalled?: (binary: string) => boolean;
    /** Called after a successful write (e.g. re-run the Claude auth preflight). */
    onChanged?: (harness: HarnessId) => void;
    now?: () => number;
}

export interface AuditRecord {
    at: number;
    action: 'apply' | 'restore';
    harness: HarnessId;
    files: string[];
    keys: string[];
    apiKeyMode?: string;
    backupId: string;
}

function harnessOf(value: unknown): HarnessId {
    if (typeof value !== 'string' || !(HARNESS_IDS as readonly string[]).includes(value)) {
        throw new ModelConfigError('invalid-harness', `harness must be one of ${HARNESS_IDS.join(', ')}`);
    }
    return value as HarnessId;
}

export class ModelConfigService {
    private readonly backups: BackupStore;
    private readonly auditPath: string;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(private readonly opts: ModelConfigServiceOptions) {
        this.backups = new BackupStore(join(opts.happyHomeDir, 'model-config-backups'));
        this.auditPath = join(opts.happyHomeDir, 'model-config-audit.jsonl');
    }

    private get ctx(): HarnessContext {
        return { home: this.opts.home, env: this.opts.env };
    }

    private serialize<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.chain.then(fn, fn);
        this.chain = next.catch(() => {});
        return next;
    }

    private async loadFiles(adapter: HarnessAdapter): Promise<{ files: FileSet; baseHash: string }> {
        const files: FileSet = {};
        for (const { role, path } of adapter.files(this.ctx)) files[role] = await readConfigFile(path);
        const baseHash = sha256(Object.entries(files).map(([role, f]) => `${role}\u0000${f.exists ? f.hash : '-'}`).join('\n'));
        return { files, baseHash };
    }

    async readOne(harness: HarnessId, providerId?: string): Promise<HarnessConfigView> {
        const adapter = ADAPTERS[harness];
        const installed = harness === 'claude' || (this.opts.isInstalled?.(adapter.binary) ?? true);
        const backups = await this.backups.list(harness);
        let loaded: { files: FileSet; baseHash: string };
        try {
            loaded = await this.loadFiles(adapter);
        } catch (error) {
            const e = toError(error);
            return {
                harness, installed, baseHash: '', current: {}, pickerModels: [], backups, warnings: [],
                files: adapter.files(this.ctx).map(f => ({ role: f.role, path: f.path, exists: false, error: e })),
            };
        }
        const files = Object.entries(loaded.files).map(([role, f]) => ({ role, path: f.path, exists: f.exists }));
        try {
            const view = adapter.view(loaded.files, this.ctx, { providerId });
            return { harness, installed, files, baseHash: loaded.baseHash, backups, ...view };
        } catch (error) {
            const e = toError(error);
            return { harness, installed, baseHash: loaded.baseHash, current: {}, pickerModels: [], backups, warnings: [], files: files.map(f => ({ ...f, error: e })) };
        }
    }

    async read(params: { harness?: unknown; providerId?: unknown } = {}): Promise<ModelConfigReadResult> {
        const list = params.harness === undefined ? [...HARNESS_IDS] : [harnessOf(params.harness)];
        const providerId = typeof params.providerId === 'string' && params.providerId ? params.providerId : undefined;
        const harnesses = await Promise.all(list.map(h => this.readOne(h, providerId)));
        return { version: MODEL_CONFIG_CAPABILITY_VERSION, harnesses };
    }

    private diffs(adapter: HarnessAdapter, files: FileSet, next: Record<string, string | null | undefined>, extraSecrets: string[]): FileDiff[] {
        const out: FileDiff[] = [];
        for (const [role, file] of Object.entries(files)) {
            const target = next[role];
            if (target === undefined) continue;
            const newText = target ?? '';
            if (target !== null && file.exists && newText === file.content) continue;
            if (target === null && !file.exists) continue;
            const secrets = [...adapter.secretsIn(role, file.content), ...(target ? adapter.secretsIn(role, target) : []), ...extraSecrets];
            const raw = unifiedDiff(file.content, newText, file.path);
            out.push({ path: file.path, diff: redactText(raw, secrets), created: !file.exists && target !== null, deleted: target === null && file.exists });
        }
        return out;
    }

    private async write(harness: HarnessId, action: 'apply' | 'restore', files: FileSet, next: Record<string, { content: string | null; mode: number | null } | undefined>, keys: string[], apiKeyMode?: string) {
        const touched = Object.entries(next).filter(([, v]) => v !== undefined) as [string, { content: string | null; mode: number | null }][];
        const snapshot: BackupFile[] = touched.map(([role]) => ({ path: files[role].path, content: files[role].exists ? files[role].content : null, mode: files[role].mode }));
        const backup = await this.backups.create(harness, action === 'apply' ? 'before-apply' : 'before-restore', snapshot, this.opts.now?.() ?? Date.now());
        for (const [role, target] of touched) {
            const file = files[role];
            if (target.content === null) await fs.rm(file.path, { force: true });
            else await atomicWriteFile(file.path, target.content, file.mode ?? target.mode);
        }
        await this.audit({ at: this.opts.now?.() ?? Date.now(), action, harness, files: touched.map(([role]) => files[role].path), keys, apiKeyMode, backupId: backup.id });
        this.opts.onChanged?.(harness);
        return backup;
    }

    private async audit(record: AuditRecord): Promise<void> {
        try {
            await fs.mkdir(this.opts.happyHomeDir, { recursive: true });
            await fs.appendFile(this.auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
        } catch {
            // audit is best effort; never fail a completed write on it
        }
    }

    apply(params: { patch?: unknown; baseHash?: unknown; dryRun?: unknown }): Promise<ModelConfigApplyResult> {
        const run = async (): Promise<ModelConfigApplyResult> => {
            const patch = params.patch as ModelConfigPatch | undefined;
            if (!patch || typeof patch !== 'object') throw new ModelConfigError('invalid-input', 'patch is required');
            const harness = harnessOf(patch.harness);
            const adapter = ADAPTERS[harness];
            const { files, baseHash } = await this.loadFiles(adapter);
            const dryRun = params.dryRun !== false;
            if (!dryRun && params.baseHash !== baseHash) {
                throw new ModelConfigError('conflict', 'The config files changed since the preview; review the new diff and apply again');
            }
            const plan = adapter.plan(files, patch, this.ctx);
            const diffs = this.diffs(adapter, files, plan.contents, plan.secrets);
            const changed = diffs.length > 0;
            if (dryRun || !changed) {
                return { harness, dryRun, changed, baseHash, files: diffs, warnings: plan.warnings };
            }
            const next = Object.fromEntries(Object.entries(plan.contents).map(([role, content]) => [role, content === undefined ? undefined : { content, mode: null }]));
            const apiKeyMode = (patch as { apiKey?: { mode?: unknown } }).apiKey?.mode;
            const backup = await this.write(harness, 'apply', files, next, plan.changedKeys, typeof apiKeyMode === 'string' ? apiKeyMode : undefined);
            const config = await this.readOne(harness, (patch as { providerId?: string }).providerId);
            return { harness, dryRun, changed, baseHash: config.baseHash, files: diffs, warnings: plan.warnings, backup, config };
        };
        return params.dryRun === false ? this.serialize(run) : run();
    }

    restore(params: { harness?: unknown; backupId?: unknown; baseHash?: unknown; dryRun?: unknown }): Promise<ModelConfigApplyResult> {
        const run = async (): Promise<ModelConfigApplyResult> => {
            const harness = harnessOf(params.harness);
            const adapter = ADAPTERS[harness];
            if (typeof params.backupId !== 'string') throw new ModelConfigError('invalid-input', 'backupId is required');
            const saved = await this.backups.read(harness, params.backupId);
            const { files, baseHash } = await this.loadFiles(adapter);
            const dryRun = params.dryRun !== false;
            if (!dryRun && params.baseHash !== baseHash) {
                throw new ModelConfigError('conflict', 'The config files changed since the preview; review the new diff and restore again');
            }
            const allowed = new Map(Object.entries(files).map(([role, f]) => [f.path, role]));
            const target: Record<string, { content: string | null; mode: number | null } | undefined> = {};
            for (const file of saved) {
                const role = allowed.get(file.path);
                // A backup only ever restores the harness's own config paths.
                if (!role) throw new ModelConfigError('backup-mismatch', 'Backup does not belong to the current config location');
                target[role] = { content: file.content, mode: file.mode };
            }
            const diffs = this.diffs(adapter, files, Object.fromEntries(Object.entries(target).map(([r, v]) => [r, v?.content])), []);
            const changed = diffs.length > 0;
            if (dryRun || !changed) return { harness, dryRun, changed, baseHash, files: diffs, warnings: [] };
            const keys = ['*restore*'];
            const backup = await this.write(harness, 'restore', files, target, keys);
            const config = await this.readOne(harness);
            return { harness, dryRun, changed, baseHash: config.baseHash, files: diffs, warnings: [], backup, config };
        };
        return params.dryRun === false ? this.serialize(run) : run();
    }
}

function toError(error: unknown): { code: string; message: string } {
    if (error instanceof ModelConfigError) return { code: error.code, message: error.message };
    return { code: 'read-failed', message: error instanceof Error ? error.message : String(error) };
}

export type { ConfigFileState };
