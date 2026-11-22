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

    it('B-952: refuses dsh with the install command, or with the Node version when that is the problem', () => {
        expect(spawnAgentUnavailableError('dsh', { pi: true, dsh: false })?.errorMessage).toContain('npm install -g @deepseek-ai/dsh')
        expect(spawnAgentUnavailableError('dsh', { pi: true })?.errorMessage).toContain('npm install -g @deepseek-ai/dsh')
        const old = spawnAgentUnavailableError('dsh', { pi: true, dsh: false, dshNode: 'v22.23.2' })?.errorMessage
        expect(old).toContain('Node.js 24.9.0+')
        expect(old).toContain('v22.23.2')
        expect(spawnAgentUnavailableError('dsh', { pi: true, dsh: false, dshNode: null })?.errorMessage).toContain('missing')
        expect(spawnAgentUnavailableError('dsh', { pi: false, dsh: true, dshNode: 'v24.9.0' })).toBeNull()
    })

    it('spawnSessionImpl consults it with the daemon\'s current availability before any spawn path', () => {
        const run = readFileSync(new URL('./run.ts', import.meta.url), 'utf8')
        const start = run.indexOf('const spawnSessionImpl = async')
        const impl = run.slice(start, run.indexOf('const assistantMode = assistantSpawnMode(options)', start))
        expect(impl).toContain('spawnAgentUnavailableError(options.agent, currentCliAvailability())')
        expect(run).toContain('apiMachineRef?.getCLIAvailability() ?? startupCliAvailability')
    })

    it('B-956: re-probes once before refusing, and every spawn path puts the found CLI dir on to the wrapper', () => {
        const run = readFileSync(new URL('./run.ts', import.meta.url), 'utf8')
        const start = run.indexOf('const spawnSessionImpl = async')
        const impl = run.slice(start, run.indexOf('const assistantMode = assistantSpawnMode(options)', start))
        expect(impl).toMatch(/if \(unavailable && apiMachineRef\) \{\s*await apiMachineRef\.recheckCliAvailability\(\);\s*unavailable = spawnAgentUnavailableError\(options\.agent, currentCliAvailability\(\)\);/)
        // tmux path
        expect(run).toContain('Object.assign(tmuxEnv, agentSpawnPathEnv(agent));')
        // plain spawn path
        expect(run).toMatch(/\.\.\.agentSpawnPathEnv\(options\.agent\),\s*\.\.\.extraEnv/)
    })

    it('B-958: resume and restart (incl. account switch) hand the wrapper the same agent PATH as a fresh spawn', () => {
        const run = readFileSync(new URL('./run.ts', import.meta.url), 'utf8')
        const body = (from: string, to: string) => {
            const start = run.indexOf(from)
            expect(start).toBeGreaterThan(-1)
            return run.slice(start, run.indexOf(to, start))
        }
        const resume = body('const resumeSessionImpl = async', 'persistRestoreRecord(happySessionId')
        expect(resume).toContain('const agentPathEnv = await relaunchAgentPathEnv(launch.args[0], apiMachineRef ? () => apiMachineRef!.recheckCliAvailability() : undefined);')
        expect(resume).toMatch(/spawnTrackedHappyProcess\(\{[\s\S]*env: \{[\s\S]*\.\.\.agentPathEnv,[\s\S]*\}/)
        const restart = body('const restartSessionImpl = async', 'persistRestoreRecord(happySessionId')
        expect(restart).toContain('const agentPathEnv = await relaunchAgentPathEnv(args[0], apiMachineRef ? () => apiMachineRef!.recheckCliAvailability() : undefined);')
        expect(restart).toMatch(/spawnTrackedHappyProcess\(\{[\s\S]*env: \{[\s\S]*\.\.\.agentPathEnv,[\s\S]*\}/)
        // Every spawnTrackedHappyProcess call site is one of: assistant re-attach (claude only),
        // fresh spawn, resume, restart — a new one must be added here deliberately.
        expect(run.match(/await spawnTrackedHappyProcess\(\{|return spawnTrackedHappyProcess\(\{/g)).toHaveLength(4)
    })
})
