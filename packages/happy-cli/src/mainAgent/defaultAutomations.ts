/**
 * B-924: the main agent's default automations (definitions in happy-wire
 * `mainAgentAutomations.ts`): list / install / switch on or off.
 *
 * "On" = the automation exists and is active; "off" pauses it (never deletes,
 * so its runs stay). Install creates only the missing ones and never touches
 * an existing one — a paused automation stays paused. The daemon installs them
 * once, the first time a main agent starts on this machine (`ensureDefaultAutomations`).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvIo } from '@/assistant/mainAgentPointer'
import {
    MAIN_AGENT_AUTOMATION_KINDS, MAIN_AGENT_AUTOMATION_NAMES, mainAgentAutomationCreate, withDefaultQuietHours,
    type Automation, type AutomationCreate, type MainAgentAutomationKind,
} from '@slopus/happy-wire'

export type DefaultsApi = {
    list: () => Promise<Automation[]>
    create: (input: AutomationCreate) => Promise<Automation>
    pause: (id: string) => Promise<Automation>
    resume: (id: string) => Promise<Automation>
}

export type DefaultState = { kind: MainAgentAutomationKind; name: string; state: 'on' | 'off' | 'missing'; id?: string; nextRunAt?: number | null; lastRunStatus?: string | null; machineId?: string }

export function machineZone(): string {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

export async function listDefaultAutomations(api: DefaultsApi): Promise<DefaultState[]> {
    const all = await api.list()
    return MAIN_AGENT_AUTOMATION_KINDS.map(kind => {
        const name = MAIN_AGENT_AUTOMATION_NAMES[kind]
        const found = all.find(a => a.name === name)
        return found
            ? { kind, name, state: found.status === 'active' ? 'on' : 'off', id: found.id, nextRunAt: found.nextRunAt, lastRunStatus: found.lastRunStatus, machineId: found.machineId }
            : { kind, name, state: 'missing' }
    })
}

/** Creates the missing ones (default on/off per kind). Returns the names created. */
export async function installDefaultAutomations(api: DefaultsApi, input: { machineId: string; tz: string }): Promise<string[]> {
    const created: string[] = []
    for (const entry of await listDefaultAutomations(api)) {
        if (entry.state !== 'missing') continue
        try {
            await api.create(mainAgentAutomationCreate(entry.kind, input))
            created.push(entry.name)
        } catch (error) {
            // A concurrent install won the name: fine.
            if ((error as { code?: unknown })?.code !== 'automation_name_taken') throw error
        }
    }
    return created
}

/** Switch one on (create if missing / resume) or off (pause; missing stays missing). */
export async function setDefaultAutomation(api: DefaultsApi, kind: MainAgentAutomationKind, on: boolean, input: { machineId: string; tz: string }): Promise<DefaultState> {
    const entry = (await listDefaultAutomations(api)).find(e => e.kind === kind)!
    if (entry.state === 'missing') {
        if (!on) return entry
        const created = await api.create(mainAgentAutomationCreate(kind, { ...input, active: true }))
        return { kind, name: entry.name, state: 'on', id: created.id, nextRunAt: created.nextRunAt, lastRunStatus: created.lastRunStatus, machineId: created.machineId }
    }
    if ((entry.state === 'on') === on) return entry
    const next = on ? await api.resume(entry.id!) : await api.pause(entry.id!)
    return { ...entry, state: next.status === 'active' ? 'on' : 'off', nextRunAt: next.nextRunAt }
}

/** Once per machine: the first main agent here installs the defaults (a marker file remembers it; deleting automations later never brings them back). */
export async function ensureDefaultAutomations(api: DefaultsApi, input: { machineId: string; tz: string; assistantHome: string }): Promise<string[] | null> {
    const marker = join(input.assistantHome, 'default-automations.json')
    try { await readFile(marker, 'utf8'); return null } catch { /* not installed yet */ }
    const created = await installDefaultAutomations(api, input)
    await mkdir(input.assistantHome, { recursive: true })
    await writeFile(marker, JSON.stringify({ v: 1, installedAt: Date.now(), created }), { mode: 0o600 })
    return created
}

export const MAIN_AGENT_CONFIG_KV_KEY = 'vh.main-agent-config.v1'

/**
 * Give the account's main agent config the default quiet hours (00:30–08:30) in
 * `tz` when it has none, keeping every other field (version CAS, one retry).
 */
export async function writeDefaultQuietHours(io: KvIo, tz: string): Promise<'written' | 'present' | 'conflict'> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const read = await io.get(MAIN_AGENT_CONFIG_KV_KEY)
        let current: unknown = null
        if (read?.value) { try { current = JSON.parse(Buffer.from(read.value, 'base64').toString('utf8')) } catch { current = null } }
        const next = withDefaultQuietHours(current, tz)
        if (!next) return 'present'
        const value = Buffer.from(JSON.stringify(next), 'utf8').toString('base64')
        if (await io.set(MAIN_AGENT_CONFIG_KV_KEY, value, read ? read.version : -1) === 'ok') return 'written'
    }
    return 'conflict'
}
