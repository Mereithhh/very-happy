/**
 * B-915 MCP tools: `wrapup_report`, `handoff_send` (this session's own
 * wrap-up / handoff) and `session_wrapup`, `session_handoff` (ask other
 * sessions — the programmatic entry for the main agent, B-910).
 *
 * Same three transports as the session peer tools: managed Claude registers
 * them in-process (startHappyServer), the Codex stdio bridge forwards them by
 * name to that HTTP server, managed pi discovers them over HAPPY_MCP_URL.
 * Execution always happens in the owning session process.
 */

import { z } from 'zod'
import type { AssistantToolRegistrar } from '@/assistant/assistantTools'
import { WRAPUP_TOOL_NAMES } from '@slopus/happy-wire'
import {
    HANDOFF_SEND_INPUT, SESSION_HANDOFF_INPUT, SESSION_WRAPUP_INPUT, WRAPUP_REPORT_INPUT,
    HandoffSendInputSchema, SessionHandoffInputSchema, SessionWrapupInputSchema, WrapupReportInputSchema,
} from './report'
import type { WrapupTracker } from './tracker'
import { requestHandoff, requestWrapup, type BuiltinRequestResult } from './request'

export { WRAPUP_TOOL_NAMES }
export type WrapupToolName = typeof WRAPUP_TOOL_NAMES[number]

const SPECS: Record<WrapupToolName, { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny>; readOnly: boolean }> = {
    wrapup_report: {
        title: 'Report Wrap-up',
        description: 'Finish a wrap-up (「收尾」): report what this session did so the user can close it from one card on their briefing board. Call it once, at the end of a wrap-up request, after saving and committing what should be kept. pending = short items that still need the user\'s confirmation (each becomes a checkbox); can_close = nothing here still needs this session. Re-calling replaces the card.',
        inputSchema: WRAPUP_REPORT_INPUT, readOnly: false,
    },
    handoff_send: {
        title: 'Hand Off To Session',
        description: 'Hand this session\'s work over to another session (「交接给…」): delivers your summary (plus artifact paths) as a handoff message through the session-message channel — this machine, another machine of the account via its daemon, or stored for a project session that is not running — and puts a handoff card on the user\'s board. archive_after archives THIS session when the turn ends, but only if a live session confirmed delivery; otherwise it stays open. Write the summary so the target can act without this conversation.',
        inputSchema: HANDOFF_SEND_INPUT, readOnly: false,
    },
    session_wrapup: {
        title: 'Ask Sessions To Wrap Up',
        description: 'Ask other sessions to wrap up (「收尾」) with the account\'s wrap-up template (or `template`): each gets one ordinary turn, and its result arrives as a card on the user\'s board — nothing is archived by this. Batch up to 20 ids. Receipt per id: queued (sent), running (already wrapping up, nothing sent — safe to repeat) or error (e.g. not running: it must be live to take a turn).',
        inputSchema: SESSION_WRAPUP_INPUT, readOnly: false,
    },
    session_handoff: {
        title: 'Ask A Session To Hand Off',
        description: 'Ask session `from` to hand its work over to the existing session `to` (「交接给…」): `from` gets one turn asking it to write a handoff summary and call handoff_send. archive_after lets `from` archive itself after a confirmed delivery. To hand off to a new session, spawn it first. Receipt: queued | running (a handoff already in progress there, nothing sent) | error.',
        inputSchema: SESSION_HANDOFF_INPUT, readOnly: false,
    },
}

export type WrapupToolExecutor = (name: WrapupToolName, args: unknown) => Promise<unknown>

export interface WrapupToolContext {
    selfId: () => string
    tracker: Pick<WrapupTracker, 'report' | 'handoff'>
    requestWrapup?: typeof requestWrapup
    requestHandoff?: typeof requestHandoff
}

function invalid(error: z.ZodError): Error {
    return new Error(`Invalid input: ${error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
}

function parse<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
    const parsed = schema.safeParse(args ?? {})
    if (!parsed.success) throw invalid(parsed.error)
    return parsed.data
}

/** Validate against the full schema (the registered shape is the same) and run. */
export async function executeWrapupTool(name: WrapupToolName, args: unknown, context: WrapupToolContext): Promise<unknown> {
    switch (name) {
        case 'wrapup_report': return context.tracker.report(parse(WrapupReportInputSchema, args))
        case 'handoff_send': {
            const input = parse(HandoffSendInputSchema, args)
            if (input.to === context.selfId()) throw new Error('That is this session; hand off to another session')
            return context.tracker.handoff(input)
        }
        case 'session_wrapup': {
            const input = parse(SessionWrapupInputSchema, args)
            const results: BuiltinRequestResult[] = await (context.requestWrapup ?? requestWrapup)(input.session_ids, {
                ...(input.template ? { template: input.template } : {}),
                ...(input.request_id ? { requestId: input.request_id } : {}),
                self: context.selfId(),
            })
            return { results }
        }
        case 'session_handoff': {
            const input = parse(SessionHandoffInputSchema, args)
            return (context.requestHandoff ?? requestHandoff)({
                from: input.from, to: input.to,
                ...(input.to_title ? { toTitle: input.to_title } : {}),
                ...(input.machine_id ? { machineId: input.machine_id } : {}),
                archiveAfter: input.archive_after === true,
                ...(input.note ? { note: input.note } : {}),
                ...(input.request_id ? { requestId: input.request_id } : {}),
            })
        }
    }
}

/** A failed handoff is reported as a tool error so the agent cannot miss it. */
function isErrorResult(name: WrapupToolName, result: unknown): boolean {
    if (name === 'handoff_send') return (result as { delivery?: string })?.delivery === 'failed'
    if (name === 'session_handoff') return (result as { state?: string })?.state === 'error'
    return false
}

export function registerWrapupTools(server: AssistantToolRegistrar, execute: WrapupToolExecutor, skip: readonly string[] = []): void {
    for (const name of WRAPUP_TOOL_NAMES) {
        if (skip.includes(name)) continue
        const spec = SPECS[name]
        server.registerTool(name, {
            description: spec.description, title: spec.title, inputSchema: spec.inputSchema,
            annotations: { readOnlyHint: spec.readOnly, idempotentHint: name === 'session_wrapup' || name === 'wrapup_report', openWorldHint: false, destructiveHint: false },
        }, async (args: any) => {
            try {
                const result = await execute(name, args ?? {})
                return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: isErrorResult(name, result) }
            } catch (error) {
                return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Wrap-up operation failed' }], isError: true }
            }
        })
    }
}
