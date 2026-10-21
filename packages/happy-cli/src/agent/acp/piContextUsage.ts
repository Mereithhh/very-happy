/**
 * B-727 (specs/2026-10-pi-context-usage.md): turn the Very Happy pi
 * extension's raw context report into the `agentState.contextUsage` the web
 * renders.
 *
 * Numerator: pi's own `getContextUsage().tokens` — the last answer's
 * input + cache read + cache write + output plus an estimate of what came
 * after it. Never a sum over turns; nothing here touches it.
 *
 * Denominator: pi gives every models.json model without `contextWindow` the
 * value 128000 (provider-composer `definition.contextWindow ?? 128000`), and
 * the model object the extension sees cannot tell that default from a real
 * value. So the wrapper reads models.json itself:
 *   configured — the provider/model is not a models.json custom model (pi's
 *                built-in registry), or its entry / modelOverrides set it;
 *   inferred   — pi defaulted it, and another registry entry with the same
 *                model id (that pi did not default too) agrees on one value;
 *   unknown    — neither: `contextWindow` keeps pi's number for older webs,
 *                new webs show no percentage.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ContextUsage } from '@slopus/happy-wire';
import { piAgentDir } from '@/modules/modelConfig/harnesses/pi';

export const PiContextReportSchema = z.object({
    source: z.literal('pi'),
    tokens: z.number().finite().nonnegative().nullable(),
    contextWindow: z.number().finite().positive(),
    model: z.string().max(200).nullable().optional(),
    provider: z.string().max(200).nullable().optional(),
    /** The pi event that produced the report (`session_compact`, `turn_end`, …). */
    event: z.string().max(64).nullable().optional(),
    /** Other registry entries with the same model id. */
    peers: z.array(z.object({ provider: z.string().max(200), contextWindow: z.number().finite().positive() })).max(8).optional(),
});
export type PiContextReport = z.infer<typeof PiContextReportSchema>;

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Whether pi's window for provider/model comes from configuration (true) or
 * from its 128000 default (false). Unreadable / unparsable models.json → true:
 * that is the pre-B-727 reading, never a new guess.
 */
export function piWindowConfigured(modelsJson: Json | null, provider: string | null | undefined, model: string | null | undefined): boolean {
    if (!modelsJson || !provider || !model) return true;
    const config = obj(obj(modelsJson.providers)?.[provider]);
    if (!config) return true;
    if (positive(obj(obj(config.modelOverrides)?.[model])?.contextWindow)) return true;
    const models = Array.isArray(config.models) ? config.models : [];
    const entry = models.map(obj).find(m => m?.id === model);
    if (!entry) return true;
    return positive(entry.contextWindow);
}

export function resolvePiContextUsage(report: PiContextReport, modelsJson: Json | null, previous: ContextUsage | null | undefined, now: number): ContextUsage {
    let windowSource: 'configured' | 'inferred' | 'unknown' = 'configured';
    let contextWindow = report.contextWindow;
    if (!piWindowConfigured(modelsJson, report.provider, report.model)) {
        const known = new Set((report.peers ?? [])
            .filter(p => p.provider !== report.provider && piWindowConfigured(modelsJson, p.provider, report.model))
            .map(p => p.contextWindow));
        if (known.size === 1) {
            windowSource = 'inferred';
            contextWindow = [...known][0];
        } else {
            windowSource = 'unknown';
        }
    }
    const compactedAt = report.event === 'session_compact' ? now
        : report.tokens === null ? previous?.compactedAt ?? null
        : null;
    return {
        source: 'pi',
        tokens: report.tokens,
        contextWindow,
        updatedAt: now,
        windowSource,
        model: report.model ?? null,
        compactedAt,
    };
}

/** models.json as pi reads it for this wrapper (`PI_CODING_AGENT_DIR` honoured); null when absent or not strict JSON. */
export function readPiModelsJson(env: NodeJS.ProcessEnv = process.env, home = homedir()): Json | null {
    try {
        return obj(JSON.parse(readFileSync(join(piAgentDir({ home, env }), 'models.json'), 'utf8')));
    } catch {
        return null;
    }
}
