/**
 * B-688 wire shapes for the `model-config-*` machine RPCs
 * (spec specs/2026-10-custom-models.md). Mirrored by the web in
 * packages/happy-web-v2/src/sync/modelConfigTypes.ts — keep both in step.
 *
 * Patch convention: a field left `undefined` keeps the file's value; `null`
 * or '' removes the key Very Happy manages. Secrets never come back: reads
 * return `SecretView`, never the value.
 */
import type { ConfigFileState } from './fileStore';

export const MODEL_CONFIG_CAPABILITY_VERSION = 1;
export const MODEL_CONFIG_RPC_METHODS = ['model-config-read', 'model-config-apply', 'model-config-restore'] as const;

export type HarnessId = 'claude' | 'codex' | 'gemini' | 'pi';
export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'codex', 'gemini', 'pi'];

/** How a credential is supplied. `env` = reference an environment variable by name. */
export type SecretInput =
    | { mode: 'keep' }
    | { mode: 'clear' }
    | { mode: 'literal'; value: string }
    | { mode: 'env'; name: string };

export interface SecretView {
    /** none: nothing configured; command: a helper/command the user wrote (not shown). */
    mode: 'none' | 'literal' | 'env' | 'command';
    /** `sk-a…9f3c` / `••••` for literal; never the value. */
    masked?: string;
    envName?: string;
    /** Whether the daemon's environment (inherited by sessions) defines envName. */
    envPresent?: boolean;
}

export interface ClaudePatch {
    harness: 'claude';
    baseUrl?: string | null;
    /** bearer → ANTHROPIC_AUTH_TOKEN (Authorization: Bearer); x-api-key → ANTHROPIC_API_KEY. */
    authHeader?: 'bearer' | 'x-api-key';
    apiKey?: SecretInput;
    model?: string | null;
    opusModel?: string | null;
    sonnetModel?: string | null;
    haikuModel?: string | null;
    /** Extra entries for Claude Code's own picker (`modelPicker.options`). Replaces the list. */
    pickerModels?: string[];
}

export interface CodexPatch {
    harness: 'codex';
    providerId: string;
    providerName?: string;
    baseUrl?: string | null;
    apiKey?: SecretInput;
    model?: string | null;
    /** true → `model_provider = providerId`; false → remove `model_provider` (back to OpenAI). */
    activate?: boolean;
}

export interface GeminiPatch {
    harness: 'gemini';
    baseUrl?: string | null;
    apiKey?: SecretInput;
    model?: string | null;
}

export interface PiPatch {
    harness: 'pi';
    providerId: string;
    baseUrl?: string | null;
    api?: string;
    apiKey?: SecretInput;
    /** Model ids of this provider. Replaces the list; existing model objects keep their extra fields. */
    models?: string[];
    /**
     * B-727: per-model `contextWindow` (tokens). A number sets it, null removes it
     * (pi then assumes 128000); models not named keep theirs. Older daemons ignore
     * the field — the web only sends it when the view carries `contextWindows`.
     */
    contextWindows?: Record<string, number | null>;
    /** true → settings.json defaultProvider/defaultModel point here. */
    activate?: boolean;
    defaultModel?: string | null;
}

export type ModelConfigPatch = ClaudePatch | CodexPatch | GeminiPatch | PiPatch;

export interface ConfigWarning {
    code: string;
    message: string;
}

export interface FileView {
    role: string;
    path: string;
    exists: boolean;
    error?: { code: string; message: string };
}

export interface BackupView {
    id: string;
    createdAt: number;
    reason: string;
    files: string[];
}

/** Per-harness current values, already masked. Shape depends on the harness. */
export interface HarnessCurrent {
    baseUrl?: string | null;
    apiKey?: SecretView;
    authHeader?: 'bearer' | 'x-api-key';
    model?: string | null;
    opusModel?: string | null;
    sonnetModel?: string | null;
    haikuModel?: string | null;
    pickerModels?: string[];
    providerId?: string | null;
    providerName?: string | null;
    api?: string | null;
    models?: string[];
    /** pi: explicit `contextWindow` per model of the selected provider (B-727; absent on older daemons). */
    contextWindows?: Record<string, number>;
    defaultModel?: string | null;
    /** codex/pi: provider currently selected by the harness. */
    activeProvider?: string | null;
    active?: boolean;
}

export interface HarnessConfigView {
    harness: HarnessId;
    /** Harness binary found on the daemon's PATH. */
    installed: boolean;
    files: FileView[];
    /** sha256 over all files; `apply`/`restore` refuse when the disk moved on. */
    baseHash: string;
    current: HarnessCurrent;
    /** codex/pi: user-defined provider ids in the file. */
    providers?: string[];
    /** Model keys the web should offer in this harness's composer picker. */
    pickerModels: string[];
    backups: BackupView[];
    warnings: ConfigWarning[];
}

export interface ModelConfigReadResult {
    version: typeof MODEL_CONFIG_CAPABILITY_VERSION;
    harnesses: HarnessConfigView[];
}

export interface FileDiff {
    path: string;
    /** Unified diff with secrets masked; '' when unchanged. */
    diff: string;
    created: boolean;
    deleted: boolean;
}

export interface ModelConfigApplyResult {
    harness: HarnessId;
    dryRun: boolean;
    changed: boolean;
    baseHash: string;
    files: FileDiff[];
    warnings: ConfigWarning[];
    backup?: BackupView;
    /** Fresh view after a real write. */
    config?: HarnessConfigView;
}

export interface HarnessContext {
    home: string;
    env: NodeJS.ProcessEnv;
}

export type FileSet = Record<string, ConfigFileState>;

export interface HarnessPlan {
    /** role → new content (undefined = untouched). */
    contents: Record<string, string | undefined>;
    warnings: ConfigWarning[];
    /** Key paths touched, for the audit line (names only). */
    changedKeys: string[];
    /** Literal secrets introduced by the patch (masked in the diff). */
    secrets: string[];
}

export interface HarnessAdapter {
    id: HarnessId;
    binary: string;
    files(ctx: HarnessContext): { role: string; path: string }[];
    view(files: FileSet, ctx: HarnessContext, opts: { providerId?: string }): Omit<HarnessConfigView, 'harness' | 'installed' | 'files' | 'baseHash' | 'backups'>;
    plan(files: FileSet, patch: ModelConfigPatch, ctx: HarnessContext): HarnessPlan;
    /** Secret values present in a file's content (for diff redaction). */
    secretsIn(role: string, content: string): Set<string>;
}
