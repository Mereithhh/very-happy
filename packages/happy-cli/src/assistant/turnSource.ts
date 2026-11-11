/**
 * B-924: who started a turn, from its prompts' localIds. An automation run
 * sends its prompt as `automation-<runId>` (daemon runner); everything else
 * (the owner typing, a board choice `board-…`, a Lead's message) counts as
 * the owner's. A batch that holds any non-automation prompt is the owner's.
 */
export const AUTOMATION_LOCAL_ID_PREFIX = 'automation-'

export function classifyTurnSource(sourceIds: readonly string[]): 'owner' | 'automation' | 'unknown' {
    if (!sourceIds.length) return 'unknown'
    return sourceIds.every(id => typeof id === 'string' && id.startsWith(AUTOMATION_LOCAL_ID_PREFIX)) ? 'automation' : 'owner'
}

let current: () => 'owner' | 'automation' | 'unknown' = () => 'unknown'
/** One main agent per wrapper process: startHappyServer installs the live source; the tools read it. */
export function installMainAgentTurnSource(source: () => 'owner' | 'automation' | 'unknown'): void { current = source }
export function mainAgentTurnSource(): 'owner' | 'automation' | 'unknown' { return current() }
