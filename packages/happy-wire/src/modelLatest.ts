import { z } from 'zod';
import bundledLatestModels from './latestModels.json';

/**
 * "Follow latest" model defaults (B-844, spec 2026-10-model-follow-latest).
 *
 * The code default model of claude / codex / gemini is the sentinel `latest`,
 * never a concrete id: it resolves at send time to the newest model of ONE
 * tier (Claude Opus, Codex sol, Gemini pro — never across tiers, cost differs
 * too much) that the session's wrapper can actually run. `latest` itself is
 * never put on the wire to a CLI: released CLIs would pass it to
 * `--model`/`turn/start` verbatim and fail.
 *
 * latestModels.json is the only place "latest" is maintained in the repo. The
 * server serves it at `GET /v1/models/latest` and an operator can replace it
 * there without a release (VH_LATEST_MODELS_FILE); web and `very-happy spawn`
 * read the server copy and fall back to this one.
 */
export const LATEST_MODEL_MODE = 'latest';

export function isLatestModelMode(model: string | null | undefined): boolean {
    return model === LATEST_MODEL_MODE;
}

export const LATEST_MODEL_AGENTS = ['claude', 'codex', 'gemini'] as const;
export type LatestModelAgent = typeof LATEST_MODEL_AGENTS[number];

export const LatestModelEntrySchema = z.object({
    model: z.string().min(1),
    label: z.string().optional(),
    /** What a machine/wrapper must have to run it. Absent = nothing provable
     *  without the session's own catalog. */
    requires: z.object({
        /** Wrapper capability (session metadata.capabilities) — AGENTS.md rule 14. */
        capability: z.string().optional(),
        /** very-happy-cli version that first advertises `capability`; only used
         *  before a session exists (launcher label). */
        cliVersion: z.string().optional(),
        /** First agent CLI (codex) whose bundled `model/list` carries the model. */
        agentVersion: z.string().optional(),
    }).optional(),
});
export type LatestModelEntry = z.infer<typeof LatestModelEntrySchema>;

export const LatestModelTierSchema = z.object({
    tier: z.string(),
    /** Regex source matching every id of the tier; its capture groups are the
     *  version (`claude-opus-5-5` → 5,5; `gpt-6.1-sol` → 6.1). */
    pattern: z.string(),
    /** Known models of the tier, newest first. */
    models: z.array(LatestModelEntrySchema),
});
export type LatestModelTier = z.infer<typeof LatestModelTierSchema>;

export const LatestModelTableSchema = z.object({
    version: z.number(),
    updatedAt: z.string().optional(),
    agents: z.object({
        claude: LatestModelTierSchema.optional(),
        codex: LatestModelTierSchema.optional(),
        gemini: LatestModelTierSchema.optional(),
    }).passthrough(),
}).passthrough();
export type LatestModelTable = z.infer<typeof LatestModelTableSchema>;

/** Response of `GET /v1/models/latest`. */
export const LatestModelsResponseSchema = z.object({
    table: LatestModelTableSchema,
    source: z.enum(['bundled', 'configured']),
});
export type LatestModelsResponse = z.infer<typeof LatestModelsResponseSchema>;

/**
 * latestModels.json — evidence (2026-10-30, kept in the B-844 PR):
 * - Claude: claude-agent-sdk 0.3.306 / Claude Code 2.1.306 knows no Opus newer
 *   than claude-opus-5-5; Opus 5.5 needs wrapper capability claude-opus-5-5-v1
 *   (CLI >= 0.2.149, B-487).
 * - Codex: the sol tier is the flagship — it is `isDefault` in Codex 0.160+'s
 *   `model/list`. Bundled catalogs: gpt-6-sol from 0.157.0, gpt-6.1-sol from
 *   0.160.0 (bisected over 0.154–0.166). `codex exec -m` ran gpt-6.1-sol,
 *   gpt-6-sol and gpt-5.6-sol end to end on 0.166.0.
 * - Gemini: gemini-3.1-pro-preview is the newest pro in the picker; Gemini
 *   sessions resolve it only from their own published catalog.
 */
export const BUNDLED_LATEST_MODELS: LatestModelTable = LatestModelTableSchema.parse(bundledLatestModels);

export type CatalogEntryLike = { code: string; value?: string; resolvedModel?: string | null };

/**
 * Where the resolution runs:
 * - `session`: a live session — its wrapper capabilities and published catalog
 *   are the only proof (versions never decide what a wrapper can do).
 * - `machine`: no session yet (new-session dialog with a machine): the
 *   machine's CLI / agent versions and a recent session's catalog. Only picks
 *   the label — the real send is resolved again once the session exists.
 * - `none`: no machine (settings page): newest known.
 */
export type LatestModelContext =
    | { kind: 'session'; capabilities?: readonly string[] | null; catalog?: readonly CatalogEntryLike[] | null }
    | { kind: 'machine'; cliVersion?: string | null; agentVersion?: string | null; catalog?: readonly CatalogEntryLike[] | null }
    | { kind: 'none'; catalog?: readonly CatalogEntryLike[] | null };

export type LatestModelResolution = {
    /** Concrete id to send, or null = the machine's own default (send nothing). */
    model: string | null;
    /** Newest id of the tier anyone knows of (table ∪ catalog). */
    newest: string | null;
    /** Display label of `model` (falls back to the id). */
    label: string | null;
    /** True when this machine/wrapper cannot run `newest`. */
    limited: boolean;
};

function compilePattern(source: string): RegExp | null {
    try {
        return new RegExp(source);
    } catch {
        return null;
    }
}

/** Numeric version of `model` within the tier, or null when not in the tier. */
export function tierVersion(tier: Pick<LatestModelTier, 'pattern'>, model: string): number[] | null {
    const match = compilePattern(tier.pattern)?.exec(model);
    if (!match) return null;
    return match.slice(1).filter((part) => part !== undefined).map((part) => Number(part));
}

/** >0 when a is newer. Missing trailing parts count as 0 (gpt-6-sol == 6.0). */
export function compareTierVersions(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** Strict semver-ish `a < b` on dotted numbers; unparsable → null. */
function versionBelow(a: string, b: string): boolean | null {
    const parse = (value: string) => {
        const core = value.trim().replace(/^v/, '').split(/[-+]/)[0];
        const parts = core.split('.').map((part) => Number(part));
        return parts.length > 0 && parts.every((part) => Number.isInteger(part) && part >= 0) ? parts : null;
    };
    const left = parse(a);
    const right = parse(b);
    if (!left || !right) return null;
    return compareTierVersions(left, right) < 0;
}

function catalogTierIds(tier: LatestModelTier, catalog: readonly CatalogEntryLike[] | null | undefined): Map<string, string> {
    const ids = new Map<string, string>();
    for (const entry of catalog ?? []) {
        for (const id of [entry.resolvedModel, entry.code]) {
            if (typeof id === 'string' && tierVersion(tier, id) && !ids.has(id)) {
                ids.set(id, entry.code === id && entry.value ? entry.value : id);
            }
        }
    }
    return ids;
}

function entryRunnable(entry: LatestModelEntry, ctx: LatestModelContext, catalogIds: Map<string, string>): boolean {
    if (catalogIds.has(entry.model)) return true;
    const requires = entry.requires;
    if (ctx.kind === 'session') {
        return !!requires?.capability && (ctx.capabilities ?? []).includes(requires.capability);
    }
    if (ctx.kind === 'machine') {
        // Unknown version = can't tell; the label shows the table's answer and
        // the session-time resolution makes the real (capability) decision.
        if (requires?.cliVersion && ctx.cliVersion && versionBelow(ctx.cliVersion, requires.cliVersion) === true) return false;
        if (requires?.agentVersion && ctx.agentVersion && versionBelow(ctx.agentVersion, requires.agentVersion) === true) return false;
        return true;
    }
    return true;
}

export function getLatestModelTier(table: LatestModelTable | null | undefined, agent: string | null | undefined): LatestModelTier | null {
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'gemini') return null;
    const tier = table?.agents?.[agent] ?? BUNDLED_LATEST_MODELS.agents[agent];
    return tier && compilePattern(tier.pattern) ? tier : (BUNDLED_LATEST_MODELS.agents[agent] ?? null);
}

/**
 * Newest model of the agent's tier that `ctx` can run. Candidates are the
 * tier ids in the catalog (the wrapper itself says it can run them) plus the
 * table entries `ctx` proves runnable; the highest version wins.
 */
export function resolveLatestModel(
    table: LatestModelTable | null | undefined,
    agent: string | null | undefined,
    ctx: LatestModelContext,
): LatestModelResolution {
    const tier = getLatestModelTier(table, agent);
    if (!tier) return { model: null, newest: null, label: null, limited: false };
    const catalogIds = catalogTierIds(tier, ctx.catalog);
    const labels = new Map<string, string>();
    const known: string[] = [];
    const runnable: string[] = [];
    for (const entry of tier.models) {
        if (!tierVersion(tier, entry.model)) continue;
        labels.set(entry.model, entry.label ?? entry.model);
        known.push(entry.model);
        if (entryRunnable(entry, ctx, catalogIds)) runnable.push(entry.model);
    }
    for (const [id, label] of catalogIds) {
        if (!labels.has(id)) labels.set(id, label);
        known.push(id);
        runnable.push(id);
    }
    const newestOf = (ids: string[]): string | null => {
        let best: { id: string; version: number[] } | null = null;
        for (const id of ids) {
            const version = tierVersion(tier, id)!;
            if (!best || compareTierVersions(version, best.version) > 0) best = { id, version };
        }
        return best?.id ?? null;
    };
    const model = newestOf(runnable);
    const newest = newestOf(known);
    const sameVersion = model !== null && newest !== null
        && compareTierVersions(tierVersion(tier, model)!, tierVersion(tier, newest)!) === 0;
    return {
        model,
        newest,
        label: model ? labels.get(model) ?? model : null,
        limited: newest !== null && !sameVersion,
    };
}

/**
 * True when `model` is what "latest" resolves to in `ctx` — picking it in a
 * session means "follow latest", not "pin this id" (B-844).
 */
export function isResolvedLatestModel(
    table: LatestModelTable | null | undefined,
    agent: string | null | undefined,
    ctx: LatestModelContext,
    model: string | null | undefined,
): boolean {
    if (!model) return false;
    const resolved = resolveLatestModel(table, agent, ctx);
    return resolved.model !== null && resolved.model === model;
}

/** Parse a server/localStorage copy; anything invalid → null (caller falls back to the bundle). */
export function parseLatestModelTable(value: unknown): LatestModelTable | null {
    const parsed = LatestModelTableSchema.safeParse(value);
    if (!parsed.success) return null;
    for (const agent of LATEST_MODEL_AGENTS) {
        const tier = parsed.data.agents[agent];
        if (tier && !compilePattern(tier.pattern)) return null;
    }
    return parsed.data;
}
