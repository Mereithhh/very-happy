import {
    OwnerBoardListInputSchema, OwnerBoardPostInputSchema, OwnerBoardResolveInputSchema, OwnerBoardUpdateInputSchema,
} from '@slopus/happy-wire';
import type { z } from 'zod';
import type { AssistantToolRegistrar } from '@/assistant/assistantTools';
import { AttentionRequestError, AttentionUnsupportedError } from './client';
import type { LeadBoard } from './leadBoard';

/**
 * B-766 `owner_board_*` MCP tools (W0 contract `OwnerBoard*InputSchema`).
 * Registered only for a team lead on a server that serves the board
 * (`LeadBoard.toolsExposed`). Inputs are validated against the full W0 schema
 * (cross-field rules like "decision needs 2–4 options") before any request.
 */

export const OWNER_BOARD_TOOL_NAMES = ['owner_board_post', 'owner_board_update', 'owner_board_resolve', 'owner_board_list'] as const;

const POST_DESCRIPTION = 'Post to the owner\'s briefing board (汇报板 / Briefing), the one place the user checks for what needs them. '
    + 'kind: decision (they must choose; 2-4 options, mark the recommended one), todo (something only they can do offline: log in, authorize, look at a device), '
    + 'report (a milestone: accepted, merged, released, incident conclusion), answer (reply_to = the owner question item id). '
    + 'Use a stable key per topic: posting the same key again updates that item instead of adding one. anchor defaults to this turn\'s reply. '
    + 'Do not also paste open decisions into chat or member replies.';
const UPDATE_DESCRIPTION = 'Edit one of this session\'s briefing board items, or set state in_progress ("on it, the result will come to the board") / open. '
    + 'Use it to refresh a reminder instead of repeating it in chat; an owner question can be reclassified only by the board itself.';
const RESOLVE_DESCRIPTION = 'Close one of this session\'s briefing board items: done, answered, dropped or superseded (say why in note).';
const LIST_DESCRIPTION = 'List this session\'s briefing board items with the owner\'s choice and note. state: open (default) or all; since: ISO-8601 or epoch ms.';

type Executor = (args: unknown) => Promise<unknown>;

function errorText(error: unknown): string {
    if (error instanceof AttentionUnsupportedError) return 'The briefing board is not available on this server right now.';
    if (error instanceof AttentionRequestError) return error.message;
    return error instanceof Error ? error.message : 'Briefing board request failed';
}

export function registerOwnerBoardTools(server: AssistantToolRegistrar, board: LeadBoard): void {
    const register = (name: typeof OWNER_BOARD_TOOL_NAMES[number], description: string, schema: z.ZodObject<z.ZodRawShape>, execute: Executor, readOnly = false) => {
        server.registerTool(name, {
            description,
            inputSchema: schema.shape,
            annotations: { readOnlyHint: readOnly, idempotentHint: true, openWorldHint: false, destructiveHint: false },
        }, async (args) => {
            const parsed = schema.safeParse(args);
            if (!parsed.success) {
                return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` }], isError: true };
            }
            try { return { content: [{ type: 'text' as const, text: JSON.stringify(await execute(parsed.data)) }], isError: false }; }
            catch (error) { return { content: [{ type: 'text' as const, text: errorText(error) }], isError: true }; }
        });
    };
    register('owner_board_post', POST_DESCRIPTION, OwnerBoardPostInputSchema, (args) => board.post(args as never));
    register('owner_board_update', UPDATE_DESCRIPTION, OwnerBoardUpdateInputSchema, (args) => board.update(args as never));
    register('owner_board_resolve', RESOLVE_DESCRIPTION, OwnerBoardResolveInputSchema, (args) => board.resolve(args as never));
    register('owner_board_list', LIST_DESCRIPTION, OwnerBoardListInputSchema, (args) => board.list(args as never), true);
}
