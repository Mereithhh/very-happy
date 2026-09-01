/**
 * Production structured-session envelope shared by runner adapters and Web.
 * Claude maps native JSONL into this format in sessionProtocolMapper; other
 * providers may still use their legacy ACP/Codex envelopes while migration is
 * incremental. Changes here are wire changes: preserve old-client tolerance,
 * update the compatibility matrix, and add mapper + reducer coverage.
 */

import { createId, isCuid } from '@paralleldrive/cuid2';
import * as z from 'zod';

export const sessionRoleSchema = z.enum(['user', 'agent']);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const sessionTextEventSchema = z.object({
  t: z.literal('text'),
  text: z.string(),
  thinking: z.boolean().optional(),
});

export const sessionServiceMessageEventSchema = z.object({
  t: z.literal('service'),
  text: z.string(),
});

export const sessionToolCallStartEventSchema = z.object({
  t: z.literal('tool-call-start'),
  call: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  args: z.record(z.string(), z.unknown()),
});

// B-260-P2: sub-agent lifecycle payloads. All optional / additive — old
// clients strip unknown keys (zod default) and keep today's behaviour.
export const sessionSubagentResultSchema = z.object({
  text: z.string(),
  truncated: z.boolean().optional(),
});
export const sessionSubagentUsageSchema = z.object({
  toolUses: z.number().optional(),
  totalTokens: z.number().optional(),
  durationMs: z.number().optional(),
});

export const sessionToolCallEndEventSchema = z.object({
  t: z.literal('tool-call-end'),
  call: z.string(),
  // Foreground Agent/Task completion: the sub-agent's final report + run
  // totals (SDK `tool_use_result`). Absent for ordinary tools and for the
  // background stub ("Async agent launched").
  result: sessionSubagentResultSchema.extend({
    isError: z.boolean().optional(),
    stats: sessionSubagentUsageSchema.extend({
      toolStats: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
  }).optional(),
});

export const sessionFileEventSchema = z.object({
  t: z.literal('file'),
  ref: z.string(),
  name: z.string(),
  size: z.number(),
  mimeType: z.string().optional(),
  image: z
    .object({
      width: z.number(),
      height: z.number(),
      thumbhash: z.string(),
    })
    .optional(),
});

export const sessionTurnStartEventSchema = z.object({
  t: z.literal('turn-start'),
});

export const sessionStartEventSchema = z.object({
  t: z.literal('start'),
  title: z.string().optional(),
  // B-260-P2: identity from SDK task_started / Agent tool input.
  description: z.string().optional(),
  subagentType: z.string().optional(),
});

export const sessionTurnEndStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
export type SessionTurnEndStatus = z.infer<typeof sessionTurnEndStatusSchema>;

// Per-turn usage snapshot, mirrors the Claude Code SDK result `usage` shape
// (snake_case, cumulative for the turn).
export const sessionTurnUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});
export type SessionTurnUsage = z.infer<typeof sessionTurnUsageSchema>;

export const sessionTurnEndEventSchema = z.object({
  t: z.literal('turn-end'),
  status: sessionTurnEndStatusSchema,
  // Human-readable SDK failure detail. Optional for backward compatibility;
  // successful and cancelled turns normally omit it.
  error: z.string().optional(),
  // Optional per-turn metadata sourced from the SDK result message. Present
  // only on turns ended by a result event; absent on lazily-closed turns.
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
  numTurns: z.number().optional(),
  usage: sessionTurnUsageSchema.optional(),
});

export const sessionStopEventSchema = z.object({
  t: z.literal('stop'),
  // B-260-P2: from SDK task_notification. A second `stop` for the same
  // subagent may follow carrying `result` once the notification user message
  // (which holds the <result> block) arrives; consumers fold by subagent id.
  status: z.enum(['completed', 'failed', 'stopped']).optional(),
  result: sessionSubagentResultSchema.optional(),
  usage: sessionSubagentUsageSchema.optional(),
});

// B-260-P2: live progress of a running sub-agent (SDK task_progress,
// throttled by the CLI). New discriminator: an old client drops only this
// envelope.
export const sessionProgressEventSchema = z.object({
  t: z.literal('progress'),
  toolUses: z.number(),
  lastTool: z.string().optional(),
  totalTokens: z.number().optional(),
  durationMs: z.number().optional(),
  summary: z.string().optional(),
});

export const sessionEventSchema = z.discriminatedUnion('t', [
  sessionTextEventSchema,
  sessionServiceMessageEventSchema,
  sessionToolCallStartEventSchema,
  sessionToolCallEndEventSchema,
  sessionFileEventSchema,
  sessionTurnStartEventSchema,
  sessionStartEventSchema,
  sessionTurnEndEventSchema,
  sessionStopEventSchema,
  sessionProgressEventSchema,
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEnvelopeSchema = z
  .object({
    id: z.string(),
    time: z.number(),
    role: sessionRoleSchema,
    turn: z.string().optional(),
    subagent: z
      .string()
      .refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
      })
      .optional(),
    // Underlying agent-protocol message id (e.g. Claude's `uuid` in the
    // session JSONL). Set on text-bearing envelopes so the app can let
    // users pick a precise rewind point for session fork / duplicate.
    claudeUuid: z.string().min(1).optional(),
    // Codex app-server item id for this envelope. Used as the precise
    // rollback point for Codex thread duplicate/fork-from-message.
    codexItemId: z.string().min(1).optional(),
    // Per-API-call token usage of the assistant message this envelope was
    // mapped from (B-108). Envelope-level (not inside `ev`) so every envelope
    // type carries it uniformly — the web feeds it into its context meter.
    // Old clients strip unknown keys (zod default) and ignore it.
    usage: sessionTurnUsageSchema.optional(),
    ev: sessionEventSchema,
  })
  .superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'service events must use role "agent"',
        path: ['role'],
      });
    }
    if (envelope.ev.t === 'progress' && !envelope.subagent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'progress events must carry a subagent',
        path: ['subagent'],
      });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop' || envelope.ev.t === 'progress') && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envelope.ev.t} events must use role "agent"`,
        path: ['role'],
      });
    }
  });

export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export type CreateEnvelopeOptions = {
  id?: string;
  time?: number;
  turn?: string;
  subagent?: string;
  claudeUuid?: string;
  codexItemId?: string;
  usage?: SessionTurnUsage;
};

export function createEnvelope(role: SessionRole, ev: SessionEvent, opts: CreateEnvelopeOptions = {}): SessionEnvelope {
  return sessionEnvelopeSchema.parse({
    id: opts.id ?? createId(),
    time: opts.time ?? Date.now(),
    role,
    ...(opts.turn ? { turn: opts.turn } : {}),
    ...(opts.subagent ? { subagent: opts.subagent } : {}),
    ...(opts.claudeUuid ? { claudeUuid: opts.claudeUuid } : {}),
    ...(opts.codexItemId ? { codexItemId: opts.codexItemId } : {}),
    ...(opts.usage ? { usage: opts.usage } : {}),
    ev,
  });
}
