/**
 * B-924 `very-happy main-agent …` — the main agent's default automations and
 * their prechecks.
 *
 *   very-happy main-agent automations [list]          state of the three defaults
 *   very-happy main-agent automations install         create the missing ones (this machine)
 *   very-happy main-agent automations on|off <kind>   brief | stuck | wrapup
 *   very-happy main-agent precheck <kind>             the zero-token gate (exit 0 = wake the main agent)
 */

import chalk from 'chalk'
import { MAIN_AGENT_AUTOMATION_KINDS, type MainAgentAutomationKind } from '@slopus/happy-wire'
import { authenticatedAutomationsClient } from '@/automations/client'
import { assistantHome } from '@/assistant/bootstrap'
import { installDefaultAutomations, listDefaultAutomations, machineZone, setDefaultAutomation } from '@/mainAgent/defaultAutomations'
import { fileLedger, runMainAgentPrecheck } from '@/mainAgent/precheck'
import { liveScanDeps } from '@/mainAgent/liveDeps'

const USAGE = `${chalk.bold('very-happy main-agent')} — the main agent's default automations

  automations [list] [--json]       brief (09:00) · stuck (hourly) · wrapup (23:30): on / off / missing
  automations install [--tz <zone>] create the missing ones on this machine (existing ones are left as they are)
  automations on|off <kind>         switch one on (creates it if missing) or off (pauses it)
  precheck <kind>                   zero-token check the automations run first; exit 0 wakes the main agent`

function kindOf(value: string | undefined): MainAgentAutomationKind {
    if ((MAIN_AGENT_AUTOMATION_KINDS as readonly string[]).includes(value ?? '')) return value as MainAgentAutomationKind
    throw new Error(`kind must be one of ${MAIN_AGENT_AUTOMATION_KINDS.join(', ')}`)
}

function flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
}

export async function handleMainAgentCommand(args: string[]): Promise<void> {
    const [group, action, arg] = args
    if (group === 'precheck') {
        const kind = kindOf(action)
        let outcome
        try {
            outcome = await runMainAgentPrecheck(kind, await liveScanDeps(), fileLedger(assistantHome()))
        } catch (error) {
            // The brief still runs on what the main agent can read itself; the other checks skip (non-zero exit).
            const reason = error instanceof Error ? error.message : String(error)
            outcome = kind === 'brief' ? { exitCode: 0, stdout: `Snapshot unavailable (${reason}); gather it with your tools.` } : { exitCode: 1, stdout: `precheck failed: ${reason}` }
        }
        process.stdout.write(outcome.stdout + '\n')
        process.exitCode = outcome.exitCode
        return
    }
    if (group === 'automations') {
        const { client, machineId } = await authenticatedAutomationsClient('cli-main-agent')
        const target = () => {
            if (!machineId) throw new Error('This machine is not registered with Very Happy yet (start the daemon once).')
            return { machineId, tz: flag(args, '--tz') ?? machineZone() }
        }
        if (action === undefined || action === 'list') {
            const states = await listDefaultAutomations(client)
            if (args.includes('--json')) { console.log(JSON.stringify(states)); return }
            for (const s of states) console.log(`${s.kind.padEnd(7)} ${s.state.padEnd(8)} ${s.name}${s.nextRunAt ? `  next ${new Date(s.nextRunAt).toISOString()}` : ''}${s.lastRunStatus ? `  last ${s.lastRunStatus}` : ''}`)
            return
        }
        if (action === 'install') {
            const created = await installDefaultAutomations(client, target())
            console.log(created.length ? `created ${created.join(', ')}` : 'all three already exist (left as they are)')
            return
        }
        if (action === 'on' || action === 'off') {
            const state = await setDefaultAutomation(client, kindOf(arg), action === 'on', target())
            console.log(`${state.name}: ${state.state}`)
            return
        }
    }
    console.log(USAGE)
    if (group !== undefined && group !== 'help' && group !== '--help' && group !== '-h') process.exitCode = 1
}
