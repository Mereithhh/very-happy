import { join } from 'node:path'
import { configuration } from '@/configuration'
import { sharedAttentionClient } from '@/attention/client'
import { boardItemView } from '@/attention/ownerApproval'
import { sharedProjectsClient } from '@/projects/client'
import { isValidSessionId } from '@/assistant/ids'
import { createSettingsApprovals } from '@/settings/approval'
import { createSettingsService, type SettingsResult } from '@/settings/service'
import { accountKey, createAccountStore, keyUnavailable, readMachineSettings, SettingsError, writeMachineSettingLocked } from '@/settings/stores'

export const SETTINGS_HELP = `very-happy settings — read and change Very Happy settings (JSON output)
  very-happy settings list [--scope account|machine|project] [--project ID]
  very-happy settings get <key> [--scope …] [--project ID]
  very-happy settings set <key> <json-value> [--scope …] [--project ID] [--reason TEXT] [--approved CARD_ID]

Scopes: account (synced settings; needs the account key on this machine), machine (this machine's
settings.json, through the daemon when it runs), project (defaults of --project or of the calling
session's project). A bare key picks its scope when it is unique. Only listed keys are writable.

High-risk changes (loosening permissions or the sandbox, server / credential settings, commands that run
by themselves) post a decision card on the calling session's board and exit 2 with
{"ok":false,"error":"needs_owner_decision","cardId"}; after the owner approves, rerun with --approved <cardId>.
Tightening is written directly. The card governs this command only: it is not a sandbox or a permission mode.`

function flag(args: string[], name: string): string | undefined {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
}

function positional(args: string[]): string[] {
    const out: string[] = []
    for (let i = 0; i < args.length; i++) {
        if (args[i]!.startsWith('--')) { if (args[i] !== '--json') i++; continue }
        out.push(args[i]!)
    }
    return out
}

/** `<json-value>`: JSON when it parses, else the raw string (`opus` = "opus"). */
export function parseValue(raw: string): unknown {
    try { return JSON.parse(raw) } catch { return raw }
}

function liveService() {
    const attention = sharedAttentionClient()
    const projects = sharedProjectsClient()
    const peer = process.env.VH_PEER_SESSION_ID
    const sessionId = peer && isValidSessionId(peer) ? peer : null
    return createSettingsService({
        account: async () => { const key = await accountKey(); return key ? createAccountStore(key) : null },
        accountUnavailable: keyUnavailable,
        machine: {
            read: readMachineSettings,
            write: async (key, value) => {
                const { setMachineSettingViaDaemon } = await import('@/daemon/controlClient')
                const viaDaemon = await setMachineSettingViaDaemon(key, value)
                if (viaDaemon === 'no-daemon') { await writeMachineSettingLocked(key, value); return }
                if (viaDaemon !== 'ok') throw new SettingsError('daemon_write_failed', { detail: viaDaemon })
            },
        },
        project: {
            read: (projectId) => projects.defaults(projectId),
            write: async (projectId, field, value) => {
                const current = await projects.defaults(projectId)
                const { project } = await projects.update(projectId, { defaults: { ...current, [field]: value } })
                return project.defaults ?? {}
            },
        },
        resolveProject: async (explicit) => {
            if (explicit) return explicit
            if (!sessionId) return null
            return (await projects.membership(sessionId)).projectId
        },
        approvals: () => createSettingsApprovals({
            dir: join(configuration.happyHomeDir, 'settings-approvals'),
            board: {
                async post(card) {
                    const { item } = await attention.post({ sessionId: card.sessionId, source: 'agent', kind: 'decision', title: card.title, bodyMd: card.bodyMd, key: card.key, requestId: card.requestId, options: card.options })
                    return boardItemView(item)
                },
                async findById(sid, id) {
                    const item = (await attention.list({ sessionId: sid, state: 'all', limit: 200 })).items.find((i) => i.id === id)
                    return item ? boardItemView(item) : null
                },
                async append(id, line) { await attention.patch(id, { appendMd: line }) },
            },
        }),
        sessionId,
        teamScoped: process.env.VH_TEAM_SCOPE_FILE !== undefined,
    })
}

export async function handleSettingsCommand(args: string[], out: (text: string) => void = (text) => console.log(text), service = liveService): Promise<number> {
    const [sub, ...rest] = args
    if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { out(SETTINGS_HELP); return 0 }
    const opts = { scope: flag(rest, '--scope'), project: flag(rest, '--project') }
    const [key, rawValue] = positional(rest)
    let result: SettingsResult
    if (sub === 'list') result = await service().list(opts)
    else if (sub === 'get') result = key ? await service().get(key, opts) : { ok: false, error: 'key_required' }
    else if (sub === 'set') {
        result = key && rawValue !== undefined
            ? await service().set(key, parseValue(rawValue), { ...opts, approved: flag(rest, '--approved'), reason: flag(rest, '--reason') })
            : { ok: false, error: 'usage', hint: 'very-happy settings set <key> <json-value>' }
    } else result = { ok: false, error: 'unknown_subcommand', hint: 'list | get | set' }
    out(JSON.stringify(result, null, 2))
    return result.ok ? 0 : result.error === 'needs_owner_decision' ? 2 : 1
}
