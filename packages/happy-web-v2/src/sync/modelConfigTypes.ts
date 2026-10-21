/**
 * B-688 wire shapes of the daemon's `model-config-*` machine RPCs
 * (specs/2026-10-custom-models.md). Mirror of
 * packages/happy-cli/src/modules/modelConfig/types.ts — keep both in step.
 * Reads never carry a secret: `SecretView` is a mode + mask.
 */
export type HarnessId = 'claude' | 'codex' | 'gemini' | 'pi';
export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'codex', 'gemini', 'pi'];

export type SecretInput =
    | { mode: 'keep' }
    | { mode: 'clear' }
    | { mode: 'literal'; value: string }
    | { mode: 'env'; name: string };

export interface SecretView {
    mode: 'none' | 'literal' | 'env' | 'command';
    masked?: string;
    envName?: string;
    envPresent?: boolean;
}

export interface ConfigWarning { code: string; message: string }
export interface FileView { role: string; path: string; exists: boolean; error?: { code: string; message: string } }
export interface BackupView { id: string; createdAt: number; reason: string; files: string[] }

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
    /** pi: explicit contextWindow per model (B-727). Absent = the daemon cannot write it yet. */
    contextWindows?: Record<string, number>;
    defaultModel?: string | null;
    activeProvider?: string | null;
    active?: boolean;
}

export interface HarnessConfigView {
    harness: HarnessId;
    installed: boolean;
    files: FileView[];
    baseHash: string;
    current: HarnessCurrent;
    providers?: string[];
    pickerModels: string[];
    backups: BackupView[];
    warnings: ConfigWarning[];
}

export interface ModelConfigReadResult { version: number; harnesses: HarnessConfigView[] }

export interface FileDiff { path: string; diff: string; created: boolean; deleted: boolean }

export interface ModelConfigApplyResult {
    harness: HarnessId;
    dryRun: boolean;
    changed: boolean;
    baseHash: string;
    files: FileDiff[];
    warnings: ConfigWarning[];
    backup?: BackupView;
    config?: HarnessConfigView;
}

export interface ClaudePatch {
    harness: 'claude';
    baseUrl?: string | null;
    authHeader?: 'bearer' | 'x-api-key';
    apiKey?: SecretInput;
    model?: string | null;
    opusModel?: string | null;
    sonnetModel?: string | null;
    haikuModel?: string | null;
    pickerModels?: string[];
}
export interface CodexPatch { harness: 'codex'; providerId: string; providerName?: string; baseUrl?: string | null; apiKey?: SecretInput; model?: string | null; activate?: boolean }
export interface GeminiPatch { harness: 'gemini'; baseUrl?: string | null; apiKey?: SecretInput; model?: string | null }
export interface PiPatch { harness: 'pi'; providerId: string; baseUrl?: string | null; api?: string; apiKey?: SecretInput; models?: string[]; contextWindows?: Record<string, number | null>; activate?: boolean; defaultModel?: string | null }
export type ModelConfigPatch = ClaudePatch | CodexPatch | GeminiPatch | PiPatch;

export const PI_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'] as const;
