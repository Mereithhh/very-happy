/**
 * B-628: stopping `codex app-server` together with what it started. The implementation moved
 * to `utils/processTree.ts` (B-629) when the ACP backends (pi, Gemini) got the same treatment;
 * these names are kept for the Codex client and its tests.
 */
export {
    stopProcessGracefully as stopCodexProcess,
    killProcessTree as killCodexProcessTree,
    type ProcessTreeDeps as CodexProcessTreeDeps,
    type StoppableProcess as StoppableCodexProcess,
    type SpawnedKiller,
} from '@/utils/processTree';
