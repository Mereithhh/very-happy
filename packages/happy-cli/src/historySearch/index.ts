/**
 * B-549 — daemon wiring for the history search service: the index lives under
 * `<HAPPY_HOME>/history-search/`, and the transcript roots come from the
 * agent-home resolution (B-478) on every pass, so a moved
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME` is followed and the results always point
 * at files the import RPCs can read.
 */
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { refreshAgentHomes } from '@/agentHome';
import { HistorySearchService } from './service';
import type { HistoryRoots } from './indexer';

export { HistorySearchService } from './service';
export type { HistorySearchResponse, HistorySearchStatus, HistorySearchState } from './service';
export type { HistoryRoots } from './indexer';

export async function resolveHistoryRoots(): Promise<HistoryRoots> {
    // allowStale: never wait on a login-shell probe for a background pass
    // (same policy as new-session spawns, B-512).
    const homes = await refreshAgentHomes(Date.now(), { allowStale: true });
    return {
        claudeProjectsRoot: join(homes.claudeConfigDir.path, 'projects'),
        codexSessionsRoot: join(homes.codexHome.path, 'sessions'),
        codexIndexPath: join(homes.codexHome.path, 'session_index.jsonl'),
    };
}

export function historySearchIndexDir(): string {
    return join(configuration.happyHomeDir, 'history-search');
}

export function createHistorySearchService(): HistorySearchService {
    return new HistorySearchService({ indexDir: historySearchIndexDir(), resolveRoots: resolveHistoryRoots });
}
