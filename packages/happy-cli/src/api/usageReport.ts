export type UsageDimensions = {
    total: number;
    input?: number;
    output?: number;
    cache_creation?: number;
    cache_read?: number;
    reasoning?: number;
};

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function finiteNonNegative(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = finiteNonNegative(source[key]);
        if (value !== undefined) return value;
    }
    return undefined;
}

/** Normalize cumulative token-count notifications from Codex and ACP agents. */
export function normalizeAgentUsage(raw: unknown): UsageDimensions | null {
    const outer = record(raw);
    if (!outer) return null;
    const wrapped = record(outer.totalTokenUsage)
        ?? record(outer.total_token_usage)
        // Codex app-server ThreadTokenUsage: { total, last, modelContextWindow }.
        ?? record(outer.total)
        ?? record(outer.usage)
        ?? outer;
    const input = firstNumber(wrapped, ['inputTokens', 'input_tokens', 'input']);
    const output = firstNumber(wrapped, ['outputTokens', 'output_tokens', 'output']);
    const cacheRead = firstNumber(wrapped, ['cachedInputTokens', 'cached_input_tokens', 'cachedReadTokens', 'cacheReadInputTokens', 'cache_read_input_tokens', 'cache_read']);
    const cacheCreation = firstNumber(wrapped, ['cacheCreationInputTokens', 'cache_creation_input_tokens', 'cachedWriteTokens', 'cacheWriteInputTokens', 'cache_write_input_tokens', 'cache_creation']);
    const reasoning = firstNumber(wrapped, ['reasoningOutputTokens', 'reasoning_output_tokens', 'thoughtTokens', 'reasoning']);
    const explicitTotal = firstNumber(wrapped, ['totalTokens', 'total_tokens', 'total']);
    // Cached input is usually a subset of input for generic providers.
    const fallbackTotal = input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined;
    const total = explicitTotal ?? fallbackTotal;
    if (total === undefined) return null;
    return {
        total,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheCreation !== undefined ? { cache_creation: cacheCreation } : {}),
        ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
    };
}

export function usageAgentKey(agent: string): string {
    return agent.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}
