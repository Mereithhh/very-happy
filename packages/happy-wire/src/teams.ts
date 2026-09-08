import { z } from 'zod';

const id = z.string().min(1).max(128);
const text = z.string().min(1).max(32000);
export const TeamActionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('archive') }),
    z.object({ type: z.literal('join'), name: id, sessionId: id, botId: id.optional() }),
    z.object({ type: z.literal('delegate'), goal: text, acceptance: z.array(text).min(1).max(32), parentTaskId: id.optional(), assigneeBotId: id.optional(), botName: id.optional(), directory: z.string().min(1).max(4096).optional(), assistant: z.enum(['claude', 'codex', 'pi-acp']).optional() }),
    z.object({ type: z.literal('message'), taskId: id, body: text, recipientBotId: id.optional() }),
    z.object({ type: z.literal('submit'), taskId: id, attemptId: id, goalVersion: z.number().int().positive(), result: text }),
    z.object({ type: z.literal('accept'), taskId: id, attemptId: id, goalVersion: z.number().int().positive() }),
    z.object({ type: z.literal('return'), taskId: id, attemptId: id, goalVersion: z.number().int().positive(), reason: text }),
    z.object({ type: z.literal('cancel'), taskId: id, attemptId: id, goalVersion: z.number().int().positive(), reason: text }),
    z.object({ type: z.literal('handoff'), taskId: id, attemptId: id, goalVersion: z.number().int().positive(), assigneeBotId: id }),
    z.object({ type: z.literal('claim-operation'), operationId: id, machineId: id }),
    z.object({ type: z.literal('complete-operation'), operationId: id, machineId: id, claimId: id, sessionId: id.optional() }),
    z.object({ type: z.literal('fail-operation'), operationId: id, machineId: id, claimId: id, error: text, unknown: z.boolean().optional() }),
    z.object({ type: z.literal('session-event'), sessionId: id, event: z.enum(['idle', 'blocked', 'exited']) }),
    z.object({ type: z.literal('message-delivered'), messageId: id }),
]);
export const TeamActionRequestSchema = z.object({ requestId: id, action: TeamActionSchema });
export const TeamCreateSchema = z.object({ name: id, machineId: id, requestId: id.optional() });
export type TeamAction = z.infer<typeof TeamActionSchema>;
export type TeamActionRequest = z.infer<typeof TeamActionRequestSchema>;
export type TeamBot = { id: string; name: string; sessionId: string | null; generation: number; root: boolean; managed: boolean; assistant: 'claude' | 'codex' | 'pi-acp'; directory: string | null; lastEvent?: 'idle' | 'blocked' | 'exited'; lastEventAt?: number };
export type TeamAttempt = { id: string; botId: string; generation: number; goalVersion: number; status: 'pending' | 'running' | 'submitted' | 'accepted' | 'cancelled' | 'superseded'; result: string | null };
export type TeamTask = { id: string; parentTaskId: string | null; goal: string; acceptance: string[]; goalVersion: number; ownerBotId: string | null; assigneeBotId: string; status: 'queued' | 'running' | 'submitted' | 'done' | 'cancelled'; attempts: TeamAttempt[]; currentAttemptId: string; cleanup: 'none' | 'pending' | 'done' | 'failed' };
export type TeamMessage = { id: string; taskId: string; senderBotId: string | null; source?: 'agent' | 'user' | 'system'; recipientBotId: string; body: string; deliveredAt: number | null; createdAt: number };
export type TeamOperation = { id: string; teamId: string; machineId: string; taskId: string; botId: string; attemptId: string; generation: number; type: 'spawn' | 'stop'; status: 'pending' | 'claimed' | 'completed' | 'failed' | 'unknown'; claimId: string | null; claimedAt: number | null; error: string | null; sessionId: string | null; directory: string | null; assistant: 'claude' | 'codex' | 'pi-acp'; prompt: string; createdAt: number };
export type TeamState = { archivedAt?: number; id: string; name: string; machineId: string; version: number; bots: TeamBot[]; tasks: TeamTask[]; messages: TeamMessage[]; operations: TeamOperation[]; createdAt: number };
export type TeamResponse = { team: TeamState; operation?: TeamOperation; credential?: { botId: string; token: string } };
