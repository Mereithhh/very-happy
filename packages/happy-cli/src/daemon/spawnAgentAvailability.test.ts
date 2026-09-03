import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PI_ADAPTER_INSTALL_HINT } from '@/agent/acp/piRunnerArgs'
import { spawnAgentUnavailableError } from './spawnAgentAvailability'

describe('spawnAgentUnavailableError (e2e bug 1: spawn --agent pi exited 0 on a machine without pi)', () => {
    it('rejects pi with the install hint when the daemon says pi is unavailable', () => {
        expect(spawnAgentUnavailableError('pi', { pi: false })).toEqual({
            type: 'error',
            errorMessage: PI_ADAPTER_INSTALL_HINT,
        })
    })

    it('lets pi through when available and never gates the other agents', () => {
        expect(spawnAgentUnavailableError('pi', { pi: true })).toBeNull()
        for (const agent of ['claude', 'codex', 'gemini', 'openclaw', undefined] as const) {
            expect(spawnAgentUnavailableError(agent, { pi: false })).toBeNull()
        }
    })

    it('spawnSessionImpl consults it with the daemon\'s current availability before any spawn path', () => {
        const run = readFileSync(new URL('./run.ts', import.meta.url), 'utf8')
        const start = run.indexOf('const spawnSessionImpl = async')
        const impl = run.slice(start, run.indexOf('const assistantMode = assistantSpawnMode(options)', start))
        expect(impl).toContain('spawnAgentUnavailableError(options.agent, currentCliAvailability())')
        expect(run).toContain('apiMachineRef?.getCLIAvailability() ?? startupCliAvailability')
    })
})
