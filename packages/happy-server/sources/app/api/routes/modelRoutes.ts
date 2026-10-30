import { readFileSync, statSync } from 'node:fs';
import {
    BUNDLED_LATEST_MODELS,
    LatestModelsResponseSchema,
    parseLatestModelTable,
    type LatestModelsResponse,
} from '@slopus/happy-wire';
import { type Fastify } from "../types";

/**
 * B-844: the "follow latest" model table, served so web and `very-happy
 * spawn` learn a new flagship without a release. Source: the JSON file named
 * by VH_LATEST_MODELS_FILE (re-read when its mtime changes, checked at most
 * every 30 s), else the table bundled in happy-wire. An unreadable or invalid
 * file never breaks the endpoint: it serves the bundled table and logs once
 * per file version.
 */
const RECHECK_MS = 30_000;

export function createLatestModelsSource(opts: {
    file?: string | null;
    now?: () => number;
    warn?: (message: string) => void;
} = {}) {
    const file = opts.file?.trim() || null;
    const now = opts.now ?? Date.now;
    const warn = opts.warn ?? ((message: string) => console.warn(message));
    let cached: LatestModelsResponse = { table: BUNDLED_LATEST_MODELS, source: 'bundled' };
    let checkedAt = -Infinity;
    let loadedMtime: number | null = null;

    return function get(): LatestModelsResponse {
        if (!file || now() - checkedAt < RECHECK_MS) return cached;
        checkedAt = now();
        try {
            const mtime = statSync(file).mtimeMs;
            if (mtime === loadedMtime) return cached;
            loadedMtime = mtime;
            const table = parseLatestModelTable(JSON.parse(readFileSync(file, 'utf8')));
            if (!table) {
                warn(`[models] ${file} is not a valid latest-models table; serving the bundled one`);
                cached = { table: BUNDLED_LATEST_MODELS, source: 'bundled' };
            } else {
                cached = { table, source: 'configured' };
            }
        } catch (error) {
            if (loadedMtime !== -1) warn(`[models] cannot read ${file} (${error instanceof Error ? error.message : String(error)}); serving the bundled table`);
            loadedMtime = -1;
            cached = { table: BUNDLED_LATEST_MODELS, source: 'bundled' };
        }
        return cached;
    };
}

export function modelRoutes(app: Fastify, source = createLatestModelsSource({ file: process.env.VH_LATEST_MODELS_FILE })) {
    app.get('/v1/models/latest', {
        schema: {
            response: { 200: LatestModelsResponseSchema },
        },
    }, async (_request, reply) => {
        reply.header('cache-control', 'public, max-age=300');
        return reply.send(source());
    });
}
