/**
 * B-688 pure helpers for the model/provider editor and the composer picker
 * (specs/2026-10-custom-models.md). No React, no stores.
 */
import { normalizeAgentKey } from './agentDefaults';
import type { HarnessConfigView, HarnessId, ModelConfigPatch, SecretInput } from './modelConfigTypes';

export function machineSupportsModelConfig(machine: { metadata?: { modelConfigVersion?: number } | null } | null | undefined): boolean {
    return (machine?.metadata?.modelConfigVersion ?? 0) >= 1;
}

/** Session flavor → the harness whose config files drive it (null: not configurable). */
export function harnessForFlavor(flavor: string | null | undefined): HarnessId | null {
    // normalizeAgentKey folds unknown flavors (opencode…) into claude; those have no config here.
    if (flavor && !['claude', 'codex', 'gemini', 'pi', 'acp'].includes(flavor)) return null;
    const key = normalizeAgentKey(flavor ?? 'claude');
    return key === 'claude' || key === 'codex' || key === 'gemini' || key === 'pi' ? key : null;
}

export const HARNESS_LABELS: Record<HarnessId, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', pi: 'pi' };

/** Append the machine's custom model keys to a picker list (by key, keeps order, no duplicates). */
export function withCustomModels<T extends { key: string; name: string; description?: string | null }>(options: T[], custom: readonly string[], description: string): (T | { key: string; name: string; description: string })[] {
    if (!custom.length) return options;
    const seen = new Set(options.map((o) => o.key));
    const extra = custom.filter((key) => key && !seen.has(key)).map((key) => ({ key, name: key, description }));
    return extra.length ? [...options, ...extra] : options;
}

export type KeyMode = 'keep' | 'literal' | 'env' | 'clear';

export interface ModelConfigForm {
    harness: HarnessId;
    /** codex/pi: provider being edited; '' + isNewProvider while creating one. */
    providerId: string;
    isNewProvider: boolean;
    providerName: string;
    baseUrl: string;
    authHeader: 'bearer' | 'x-api-key';
    keyMode: KeyMode;
    keyValue: string;
    keyEnv: string;
    model: string;
    opusModel: string;
    sonnetModel: string;
    haikuModel: string;
    /**
     * claude: extra picker models; pi: the provider's model ids. One per line or comma-separated.
     * pi (B-727): a line may end with the model's context window — `glm-5.3 200k`.
     */
    extraModels: string;
    api: string;
    activate: boolean;
}

export function splitModelList(text: string): string[] {
    const out: string[] = [];
    for (const part of text.split(/[\n,]+/)) {
        const id = part.trim();
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

/** `1000000` → `1M`, `262144` → `262144` (only exact k/M multiples are shortened). */
export function formatContextWindow(tokens: number): string {
    if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
    if (tokens % 1000 === 0) return `${tokens / 1000}k`;
    return String(tokens);
}

/** `200k` / `1M` / `1.5m` / `262144` → tokens; null when it is not a size. k = 1000, M = 1 000 000. */
export function parseContextWindow(text: string): number | null {
    const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(text.trim());
    if (!m) return null;
    const n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1000 : 1_000_000) : 1);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export interface PiModelLines {
    ids: string[];
    /** Window written after an id; ids without one are absent. */
    windows: Record<string, number>;
    /** The first line that is neither `id` nor `id <size>`. */
    invalid: string | null;
}

/** B-727: the pi model list — `id` or `id <size>` per line (commas also separate entries). */
export function parsePiModelLines(text: string): PiModelLines {
    const out: PiModelLines = { ids: [], windows: {}, invalid: null };
    for (const part of text.split(/[\n,]+/)) {
        const line = part.trim();
        if (!line) continue;
        const m = /^(\S+)(?:\s+(.+))?$/.exec(line);
        const id = m?.[1] ?? '';
        const window = m?.[2] === undefined ? undefined : parseContextWindow(m[2]);
        if (!m || window === null) { out.invalid ??= line; continue; }
        if (!out.ids.includes(id)) out.ids.push(id);
        if (window !== undefined) out.windows[id] = window;
    }
    return out;
}

/** What blocks a pi preview: a malformed line, or windows on a daemon that cannot write them. */
export function piModelLinesError(form: ModelConfigForm, view: HarnessConfigView | null | undefined): { code: 'invalid-line' | 'needs-upgrade'; line?: string } | null {
    if (form.harness !== 'pi') return null;
    const parsed = parsePiModelLines(form.extraModels);
    if (parsed.invalid) return { code: 'invalid-line', line: parsed.invalid };
    if (Object.keys(parsed.windows).length && view?.current.contextWindows === undefined) return { code: 'needs-upgrade' };
    return null;
}

export function formFromView(harness: HarnessId, view: HarnessConfigView | null | undefined): ModelConfigForm {
    const c = view?.current ?? {};
    const hasProvider = (harness === 'codex' || harness === 'pi') && !!c.providerId;
    return {
        harness,
        providerId: hasProvider ? c.providerId ?? '' : '',
        isNewProvider: (harness === 'codex' || harness === 'pi') && !hasProvider,
        providerName: c.providerName ?? '',
        baseUrl: c.baseUrl ?? '',
        authHeader: c.authHeader ?? 'bearer',
        keyMode: 'keep',
        keyValue: '',
        keyEnv: c.apiKey?.mode === 'env' ? c.apiKey.envName ?? '' : '',
        model: harness === 'pi' ? c.defaultModel && c.active ? c.defaultModel : '' : c.model ?? '',
        opusModel: c.opusModel ?? '',
        sonnetModel: c.sonnetModel ?? '',
        haikuModel: c.haikuModel ?? '',
        extraModels: (harness === 'pi'
            ? (c.models ?? []).map((id) => c.contextWindows?.[id] ? `${id} ${formatContextWindow(c.contextWindows[id])}` : id)
            : c.pickerModels ?? []).join('\n'),
        api: c.api ?? 'openai-completions',
        activate: harness === 'codex' || harness === 'pi' ? (hasProvider ? !!c.active : true) : false,
    };
}

/**
 * The form for the current selection. A NEW codex/pi provider starts empty,
 * except Codex's top-level `model`, which is not per provider: starting it
 * empty would make the patch delete the user's model.
 */
export function newProviderForm(harness: HarnessId, isNew: boolean, view: HarnessConfigView | null | undefined): ModelConfigForm {
    if (!isNew) return formFromView(harness, view);
    const base = formFromView(harness, null);
    return { ...base, isNewProvider: true, providerId: '', activate: true, model: harness === 'codex' ? view?.current.model ?? '' : '' };
}

function secretFromForm(form: ModelConfigForm): SecretInput | undefined {
    if (form.keyMode === 'literal') return form.keyValue.trim() ? { mode: 'literal', value: form.keyValue.trim() } : undefined;
    if (form.keyMode === 'env') return form.keyEnv.trim() ? { mode: 'env', name: form.keyEnv.trim() } : undefined;
    if (form.keyMode === 'clear') return { mode: 'clear' };
    return undefined;
}

/** `v` unless equal to the current value (→ undefined = keep); '' → null = remove. */
function changed(next: string, current: string | null | undefined): string | null | undefined {
    const v = next.trim();
    if (v === (current ?? '').trim()) return undefined;
    return v === '' ? null : v;
}

function sameList(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Minimal patch: only fields the user changed, so the daemon's diff shows exactly that. */
export function patchFromForm(form: ModelConfigForm, view: HarnessConfigView | null | undefined): ModelConfigPatch {
    const c = form.isNewProvider ? {} : view?.current ?? {};
    const apiKey = secretFromForm(form);
    const baseUrl = form.isNewProvider ? (form.baseUrl.trim() || null) : changed(form.baseUrl, c.baseUrl);
    const strip = <T extends object>(obj: T): T => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
    switch (form.harness) {
        case 'claude': {
            const picker = splitModelList(form.extraModels);
            return strip({
                harness: 'claude' as const,
                baseUrl,
                authHeader: form.authHeader !== (c.authHeader ?? 'bearer') ? form.authHeader : undefined,
                apiKey,
                model: changed(form.model, c.model),
                opusModel: changed(form.opusModel, c.opusModel),
                sonnetModel: changed(form.sonnetModel, c.sonnetModel),
                haikuModel: changed(form.haikuModel, c.haikuModel),
                pickerModels: sameList(picker, c.pickerModels ?? []) ? undefined : picker,
            });
        }
        case 'codex':
            return strip({
                harness: 'codex' as const,
                providerId: form.providerId.trim(),
                providerName: form.providerName.trim() && form.providerName.trim() !== (c.providerName ?? '') ? form.providerName.trim() : undefined,
                baseUrl,
                apiKey,
                model: changed(form.model, view?.current.model),
                activate: form.activate !== !!c.active ? form.activate : undefined,
            });
        case 'gemini':
            return strip({ harness: 'gemini' as const, baseUrl, apiKey, model: changed(form.model, c.model) });
        case 'pi': {
            const { ids: models, windows } = parsePiModelLines(form.extraModels);
            // B-727: only daemons that report contextWindows can write them (older ones ignore the field).
            let contextWindows: Record<string, number | null> | undefined;
            if (view?.current.contextWindows !== undefined) {
                const current = form.isNewProvider ? {} : view.current.contextWindows;
                for (const id of models) {
                    const next = windows[id] ?? null;
                    if (next !== (current[id] ?? null)) (contextWindows ??= {})[id] = next;
                }
            }
            return strip({
                harness: 'pi' as const,
                providerId: form.providerId.trim(),
                baseUrl,
                api: form.isNewProvider || form.api !== (c.api ?? '') ? form.api : undefined,
                apiKey,
                models: sameList(models, c.models ?? []) ? undefined : models,
                contextWindows,
                activate: form.activate !== !!c.active ? form.activate : undefined,
                defaultModel: form.activate && form.model.trim() && form.model.trim() !== (c.defaultModel ?? '') ? form.model.trim() : undefined,
            });
        }
    }
}

/** RPC failure → what the editor shows. */
export function describeModelConfigError(result: { error: string; code?: string; unsupported: boolean }): { kind: 'unsupported' | 'conflict' | 'invalid' | 'failed'; message: string } {
    if (result.unsupported) return { kind: 'unsupported', message: result.error };
    if (result.code === 'conflict') return { kind: 'conflict', message: result.error };
    if (result.code && ['invalid-input', 'invalid-harness', 'json-has-comments', 'invalid-json', 'invalid-toml', 'unsafe-edit', 'unexpected-shape'].includes(result.code)) {
        return { kind: 'invalid', message: result.error };
    }
    return { kind: 'failed', message: result.error };
}
