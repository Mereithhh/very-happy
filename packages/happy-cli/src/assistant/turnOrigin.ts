/**
 * B-924 (QA P1-2): who started the main agent's current turn — an ALLOWLIST.
 *
 * Only a person typing in a Very Happy client (`meta.sentFrom` web / mobile /
 * ios / android — the same list the Lead board uses to recognise the owner)
 * makes a turn the owner's. Everything else is not the owner: automation runs
 * (`automation-…`), `very-happy send`, session_message, Lead / team messages,
 * remote sends, task notifications with no prompt at all. A batch is the
 * owner's only when every prompt in it is.
 *
 * Owner-only tools (wrap-up, hand-off incl. handoff_send, archive, kill, restart,
 * self-restart, team cancel / hand-off) refuse every turn that is not the
 * owner's with `owner_request_required`.
 *
 * Fail-closed: no `sentFrom`, an empty one or one off the list (e.g. `cli`), a
 * localId the tracker never saw routed, a turn with no prompt, or no tracker
 * installed — none of these is the owner. Only `owner` unlocks anything.
 *
 * Limit, and how B-927 plugs in: `sentFrom` is set by the sending client, so a
 * process holding the account's machine token can still claim `web`. B-927
 * stamps each user message on the server from the sending token's kind
 * (e.g. `meta.origin: 'human' | 'machine'`). `promptOrigin` is the one place to
 * read it: with the stamp present, only `human` (and no automated localId
 * prefix) is the owner; without it (an older server) the `sentFrom` list above
 * applies. Once every server stamps, a missing stamp can be read as not-owner.
 * Callers and OWNER_ONLY_TOOLS do not change.
 *
 * Shared interface (B-925 / #944 use it too):
 *   classifyTurnOrigin(prompts)          pure verdict for one batch
 *   createTurnOriginTracker()            onUserMessage / onTurnStart / current
 *   installMainAgentTurnOrigin(fn) / mainAgentTurnOrigin() / isOwnerTurn()
 *   OWNER_ONLY_TOOLS, ownerOnlyRefusal(), withOwnerOnlyTools(registrar, isOwner)
 */

import type { AssistantToolRegistrar } from './assistantTools'
import { MAIN_AGENT_OWNER_ONLY_TOOLS } from './mainAgentToolPolicy'

/** `meta.sentFrom` of a person typing in a Very Happy client (leadBoard's owner rule uses this list). */
export const OWNER_SENT_FROM = ['web', 'mobile', 'ios', 'android'] as const
/** localId prefixes stamped by automated senders: never the owner, whatever `sentFrom` says. */
export const AUTOMATED_LOCAL_ID_PREFIXES = ['automation-', 'teams-', 'remote-send-', 'session-message-', 'edit-conflict-', 'wrapup-', 'handoff-'] as const

export type TurnOrigin = 'owner' | 'automation' | 'agent' | 'unknown'
export type TurnPrompt = { localId?: string | null; sentFrom?: string | null }

/** One prompt: the owner's only when typed in a client and not stamped by an automated sender. */
export function promptOrigin(prompt: TurnPrompt | undefined): TurnOrigin {
    if (!prompt) return 'unknown'
    const localId = prompt.localId ?? ''
    if (localId.startsWith('automation-')) return 'automation'
    if (AUTOMATED_LOCAL_ID_PREFIXES.some(prefix => localId.startsWith(prefix))) return 'agent'
    return typeof prompt.sentFrom === 'string' && (OWNER_SENT_FROM as readonly string[]).includes(prompt.sentFrom) ? 'owner' : 'agent'
}

/** A batch: `owner` only when every prompt is; `automation` when every prompt is an automation run; empty = `unknown`. */
export function classifyTurnOrigin(prompts: readonly (TurnPrompt | undefined)[]): TurnOrigin {
    if (!prompts.length) return 'unknown'
    const origins = prompts.map(promptOrigin)
    if (origins.every(o => o === 'owner')) return 'owner'
    if (origins.every(o => o === 'automation')) return 'automation'
    return origins.includes('unknown') && origins.every(o => o === 'unknown') ? 'unknown' : 'agent'
}

/** Remembers each routed prompt's sentFrom by localId, and the verdict of the turn that started last. */
export function createTurnOriginTracker(max = 200) {
    const seen = new Map<string, TurnPrompt>()
    let current: TurnOrigin = 'unknown'
    return {
        onUserMessage(prompt: TurnPrompt): void {
            if (!prompt.localId) return
            seen.delete(prompt.localId)
            seen.set(prompt.localId, { localId: prompt.localId, sentFrom: prompt.sentFrom ?? null })
            while (seen.size > max) seen.delete(seen.keys().next().value as string)
        },
        /** `sourceIds` = the batch's prompt localIds; a turn without them (task notification, unknown) is not the owner's. */
        onTurnStart(sourceIds?: readonly string[]): void {
            current = sourceIds?.length ? classifyTurnOrigin(sourceIds.map(id => seen.get(id) ?? { localId: id, sentFrom: null })) : 'unknown'
        },
        current: (): TurnOrigin => current,
    }
}

let installed: () => TurnOrigin = () => 'unknown'
/** One main agent per wrapper process: startHappyServer installs the live tracker. Nothing installed = not the owner. */
export function installMainAgentTurnOrigin(source: () => TurnOrigin): void { installed = source }
export function mainAgentTurnOrigin(): TurnOrigin { return installed() }
export function isOwnerTurn(): boolean { return installed() === 'owner' }

/**
 * B-924 (QA P2-5): the main agent's turn-end pushes ("It's ready!", turn failed)
 * are for the owner's own turns; a turn anything else started ends silently.
 */
export function silentMainAgentTurn(isMainAgent: boolean, origin: TurnOrigin = mainAgentTurnOrigin()): boolean {
    return isMainAgent && origin !== 'owner'
}

/**
 * Tools that only run in a turn the owner started: everything that ends, archives, restarts or hands over
 * a session, the main agent itself included (B-924b: + handoff_send, request_idle_restart, team_cancel,
 * team_handoff). The list is class ① of mainAgentToolPolicy.ts.
 */
export const OWNER_ONLY_TOOLS = MAIN_AGENT_OWNER_ONLY_TOOLS

export function ownerOnlyRefusal(origin: TurnOrigin = mainAgentTurnOrigin()): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'owner_request_required', origin, note: 'Only the owner typing in a Very Happy client can ask for this; suggest it instead (wrapup_suggest, or a board card) and let the owner choose.' }) }],
        isError: true,
    }
}

/** Registrar wrapper: every OWNER_ONLY_TOOLS tool refuses unless `isOwner()` (checked per call, before the tool runs). */
export function withOwnerOnlyTools(inner: AssistantToolRegistrar, isOwner: () => boolean = isOwnerTurn, names: readonly string[] = OWNER_ONLY_TOOLS): AssistantToolRegistrar {
    const guarded = new Set(names)
    return {
        registerTool: ((name: string, config: unknown, handler: (...args: any[]) => any) => {
            if (!guarded.has(name)) return (inner.registerTool as any)(name, config, handler)
            return (inner.registerTool as any)(name, config, async (...args: any[]) => isOwner() ? handler(...args) : ownerOnlyRefusal())
        }) as AssistantToolRegistrar['registerTool'],
    }
}
