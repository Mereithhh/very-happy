import { Usage } from '../api/types';

/**
 * Pricing rates (USD per million tokens) for Claude models.
 *
 * Source: https://www.anthropic.com/pricing (Claude 5 family as of 2026-09;
 * older rows kept for JSONL backfills of historical sessions). The
 * `cache_write` column is the 5-minute cache write (1.25× input); the
 * `cache_read` column is 0.1× input except where Anthropic publishes a
 * different rate (Fable 5.1: $0.25).
 *
 * Lookup is by exact id first, then by `resolvePricingKey` which classifies
 * an arbitrary id (aliases like `opus[1m]`, dated snapshots, Bedrock ARNs)
 * by family + generation. Unknown ids fall back to the current default
 * model of that family — never to a Claude 3 rate, which made Claude 5
 * sessions report Claude 3 Opus prices (15/75) before this table existed.
 */
export const PRICING = {
    // --- Claude Fable (Mythos-class tier) ---
    'claude-fable-5-1': { input: 10.0, output: 50.0, cache_write: 12.5, cache_read: 0.25 },
    'claude-fable-5': { input: 10.0, output: 50.0, cache_write: 12.5, cache_read: 1.0 },

    // --- Claude 5 ---
    'claude-opus-5': { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.50 },
    'claude-sonnet-5': { input: 2.0, output: 10.0, cache_write: 2.5, cache_read: 0.20 },

    // --- Claude 4.x ---
    'claude-opus-4-8': { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.50 },
    'claude-opus-4-7': { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.50 },
    'claude-opus-4-6': { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.50 },
    'claude-opus-4-5': { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.50 },
    'claude-opus-4-1': { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.50 },
    'claude-opus-4': { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.50 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 },
    'claude-sonnet-4-5': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 },
    'claude-sonnet-4': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0, cache_write: 1.25, cache_read: 0.10 },

    // --- Legacy / Claude 3 ---
    'claude-3-opus-20240229': { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.5 },
    'claude-3-sonnet-20240229': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 },
    'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 },
    'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 },
    'claude-3-7-sonnet-20250219': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 },
    'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cache_write: 0.3125, cache_read: 0.025 },
    'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0, cache_write: 1.0, cache_read: 0.08 },
} as const;

export type ModelId = keyof typeof PRICING;

/** Unknown / missing model → current Claude Code default (Opus 5). */
const DEFAULT_MODEL: ModelId = 'claude-opus-5';

const FAMILY_DEFAULTS: Record<'fable' | 'opus' | 'sonnet' | 'haiku', ModelId> = {
    fable: 'claude-fable-5-1',
    opus: 'claude-opus-5',
    sonnet: 'claude-sonnet-5',
    haiku: 'claude-haiku-4-5',
};

/**
 * Map any model identifier Claude reports (or the user picks) onto a row of
 * `PRICING`. Handles the exact ids, Claude Code aliases (`opus`, `fable[1m]`,
 * `opusplan`), dated snapshots (`claude-opus-4-5-20251101`), dotted versions
 * (`claude-4.5-opus`) and provider prefixes (`us.anthropic.claude-…-v1:0`).
 */
export function resolvePricingKey(modelId?: string | null): ModelId {
    if (!modelId) return DEFAULT_MODEL;
    const raw = modelId.trim().toLowerCase();
    if (raw in PRICING) return raw as ModelId;

    // Strip the 1M-context marker and provider decorations before matching.
    const id = raw.replace(/\[1m\]$/, '');
    if (id in PRICING) return id as ModelId;

    const family = (['fable', 'opus', 'sonnet', 'haiku'] as const).find((f) => id.includes(f));
    if (!family) return DEFAULT_MODEL;

    // Generation: "5-1" / "5.1" / "4-8" / "4.8" / "3-5" … / bare "5" / "4".
    const version = id.match(/(?:^|[^0-9])(\d)(?:[-._](\d))?(?:[^0-9]|$)/);
    const major = version ? version[1] : null;
    const minor = version && version[2] ? version[2] : null;
    const key = major ? `claude-${family}-${major}${minor ? `-${minor}` : ''}` : null;
    if (key && key in PRICING) return key as ModelId;

    // Claude 3 rows are dated; pick by minor version when the id says 3.x.
    if (major === '3') {
        if (family === 'opus') return 'claude-3-opus-20240229';
        if (family === 'haiku') return minor === '5' ? 'claude-3-5-haiku-20241022' : 'claude-3-haiku-20240307';
        if (minor === '7') return 'claude-3-7-sonnet-20250219';
        return minor === '5' ? 'claude-3-5-sonnet-20241022' : 'claude-3-sonnet-20240229';
    }
    return FAMILY_DEFAULTS[family];
}

/**
 * Calculate cost for usage
 * @param usage - Usage stats
 * @param modelId - Model ID (optional, defaults to the current Claude Code default)
 */
export function calculateCost(usage: Usage, modelId?: string): { total: number, input: number, output: number } {
    const pricing = PRICING[resolvePricingKey(modelId)];

    const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;

    // Cache costs
    const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cache_write;
    const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cache_read;

    const totalInputCost = inputCost + cacheWriteCost + cacheReadCost;

    return {
        total: totalInputCost + outputCost,
        input: totalInputCost,
        output: outputCost
    };
}
