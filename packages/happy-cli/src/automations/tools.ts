/**
 * `automation_*` MCP tools (B-496). One schema, three transports:
 * managed Claude registers them in-process (startHappyServer), the Codex
 * stdio bridge forwards them by name to that HTTP server, and managed pi
 * discovers them through `tools/list` over HAPPY_MCP_URL. The bridge must
 * never bootstrap account authority itself, so execution always happens in
 * the owning session process (`executeAutomationTool`).
 */

import { z } from 'zod';
import {
    AutomationActionSchema, AutomationConcurrencySchema, AutomationNameSchema, AutomationTriggerSchema,
    type Automation, type AutomationCreate, type AutomationReport, type AutomationUpdate,
} from '@slopus/happy-wire';
import type { AssistantToolRegistrar } from '@/assistant/assistantTools';
import { authenticatedAutomationsClient, automationRunIdFromEnv, type AutomationsClient } from './client';

export const AUTOMATION_TOOL_NAMES = [
    'automation_list', 'automation_get', 'automation_create', 'automation_update', 'automation_pause', 'automation_resume',
    'automation_delete', 'automation_run', 'automation_fire', 'automation_runs', 'automation_report', 'automation_ack',
] as const;
export type AutomationToolName = typeof AUTOMATION_TOOL_NAMES[number];

const id = z.string().min(1).max(128);
const ref = { name: AutomationNameSchema.optional().describe('Automation name'), id: id.optional().describe('Automation id (alternative to name)') };
const payload = z.string().max(65_536).optional().describe('Payload text; JSON lets prompts use {{payload.field}}');
const maxRuntimeMs = z.number().int().min(60_000).max(7 * 86_400_000).optional();

/** Input schemas, shared verbatim by the in-process server and the stdio bridge. */
export const AUTOMATION_TOOL_SCHEMAS: Record<AutomationToolName, { description: string; readOnly?: boolean; destructive?: boolean; inputSchema: Record<string, z.ZodTypeAny> }> = {
    automation_list: { description: 'List this account’s automations (name, trigger, action, machine, status, next run). Defaults to every machine.', readOnly: true, inputSchema: { machineId: id.optional().describe("Only this machine id, or 'this' for the current machine") } },
    automation_get: { description: 'Read one automation by name or id, including its version (needed for automation_update).', readOnly: true, inputSchema: ref },
    automation_create: {
        description: 'Create an automation: a trigger (cron+tz / interval / once / manual) and an action (spawn a session, send into a session, or run a script argv) on one machine. Defaults to the current machine. Prompts and argv may use {{payload}}, {{payload.path}}, {{run.id}}, {{automation.name}}, {{now}}.',
        inputSchema: {
            name: AutomationNameSchema, description: z.string().max(4000).optional(),
            machineId: id.optional().describe("Target machine id; omit or 'this' for the current machine"),
            trigger: AutomationTriggerSchema, action: AutomationActionSchema,
            concurrency: AutomationConcurrencySchema.optional().describe('skip (default): a run while another is active is recorded as skipped; queue: it waits'),
            maxRuntimeMs, paused: z.boolean().optional().describe('Create paused'),
        },
    },
    automation_update: {
        description: 'Change an automation (name / description / machine / trigger / action / concurrency / maxRuntimeMs). Requires the current version from automation_get; a stale version is rejected.',
        inputSchema: {
            ...ref, version: z.number().int().positive(), newName: AutomationNameSchema.optional(), description: z.string().max(4000).nullable().optional(),
            machineId: id.optional(), trigger: AutomationTriggerSchema.optional(), action: AutomationActionSchema.optional(),
            concurrency: AutomationConcurrencySchema.optional(), maxRuntimeMs,
        },
    },
    automation_pause: { description: 'Pause an automation: no new scheduled runs and fire is refused until resumed.', inputSchema: ref },
    automation_resume: { description: 'Resume a paused automation; the next run is computed from now.', inputSchema: ref },
    automation_delete: { description: 'Delete an automation and its run history. Irreversible.', destructive: true, inputSchema: ref },
    automation_run: { description: 'Queue one run of an automation now (source: manual), optionally with a payload.', inputSchema: { ...ref, payload } },
    automation_fire: { description: 'Trigger an automation by name as an external event, with an optional payload and dedupe key (the same key within 24h returns the original run).', inputSchema: { name: AutomationNameSchema, payload, dedupeKey: z.string().min(1).max(256).optional() } },
    automation_runs: { description: 'List runs, newest first: status, session, summary, error, attention. Filter by automation, status or attention.', readOnly: true, inputSchema: { ...ref, status: z.string().min(1).max(64).optional(), attention: z.boolean().optional().describe('Only runs flagged for a human'), limit: z.number().int().min(1).max(200).optional() } },
    automation_report: {
        description: 'Report the result of an automation run. Defaults to the run this session was started for (VH_AUTOMATION_RUN_ID). Use status done with a short summary, or failed with the error; set needsAttention when a human must look.',
        inputSchema: { runId: id.optional(), status: z.enum(['done', 'failed']), summary: z.string().max(4096).optional(), error: z.string().max(4096).optional(), needsAttention: z.boolean().optional(), attentionReason: z.string().max(512).optional() },
    },
    automation_ack: { description: 'Clear the attention flag of a run after a human handled it.', inputSchema: { runId: id } },
};

export interface AutomationToolContext {
    client: AutomationsClient;
    /** This machine's id; `'this'` and omitted machine ids resolve to it. */
    machineId?: string;
    env?: NodeJS.ProcessEnv;
}

async function resolve(context: AutomationToolContext, args: { name?: string; id?: string }): Promise<Automation> {
    if (args.id) return context.client.get(args.id);
    if (args.name) return context.client.getByName(args.name);
    throw new Error('Give the automation name or id');
}

function machineFor(context: AutomationToolContext, requested: string | undefined): string | undefined {
    if (requested && requested !== 'this') return requested;
    return context.machineId;
}

function requireMachine(context: AutomationToolContext, requested: string | undefined): string {
    const machine = machineFor(context, requested);
    if (!machine) throw new Error('This machine is not registered with Very Happy; pass machineId explicitly');
    return machine;
}

/** Execute one tool against the account client. Throws on failure; callers wrap into MCP results. */
export async function executeAutomationTool(name: AutomationToolName, args: any, context: AutomationToolContext): Promise<unknown> {
    const { client } = context;
    switch (name) {
        case 'automation_list': return { automations: await client.list(machineFor(context, args.machineId)) };
        case 'automation_get': return { automation: await resolve(context, args) };
        case 'automation_create': {
            const input: AutomationCreate = {
                name: args.name, machineId: requireMachine(context, args.machineId), trigger: args.trigger, action: args.action,
                ...(args.description !== undefined ? { description: args.description } : {}),
                ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
                ...(args.maxRuntimeMs !== undefined ? { maxRuntimeMs: args.maxRuntimeMs } : {}),
                ...(args.paused ? { status: 'paused' as const } : {}),
            };
            return { automation: await client.create(input) };
        }
        case 'automation_update': {
            const current = await resolve(context, args);
            const input: AutomationUpdate = {
                version: args.version,
                ...(args.newName !== undefined ? { name: args.newName } : {}),
                ...(args.description !== undefined ? { description: args.description } : {}),
                ...(args.machineId !== undefined ? { machineId: machineFor(context, args.machineId) } : {}),
                ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
                ...(args.action !== undefined ? { action: args.action } : {}),
                ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
                ...(args.maxRuntimeMs !== undefined ? { maxRuntimeMs: args.maxRuntimeMs } : {}),
            };
            return { automation: await client.update(current.id, input) };
        }
        case 'automation_pause': return { automation: await client.pause((await resolve(context, args)).id) };
        case 'automation_resume': return { automation: await client.resume((await resolve(context, args)).id) };
        case 'automation_delete': { const target = await resolve(context, args); await client.remove(target.id); return { deleted: true, id: target.id, name: target.name }; }
        case 'automation_run': return { run: await client.run((await resolve(context, args)).id, args.payload !== undefined ? { payload: args.payload } : {}) };
        case 'automation_fire': return client.fire(args.name, { ...(args.payload !== undefined ? { payload: args.payload } : {}), ...(args.dedupeKey !== undefined ? { dedupeKey: args.dedupeKey } : {}) });
        case 'automation_runs': {
            const automationId = args.id ?? (args.name ? (await client.getByName(args.name)).id : undefined);
            return { runs: await client.runs({ automationId, status: args.status, attention: args.attention === true, limit: args.limit }) };
        }
        case 'automation_report': {
            const runId = args.runId ?? automationRunIdFromEnv(context.env ?? process.env);
            if (!runId) throw new Error('No run id: pass runId (this session was not started by an automation)');
            // No claimId: the daemon holds it. The server accepts account-level terminal reports.
            const report = {
                status: args.status,
                ...(args.summary !== undefined ? { summary: args.summary } : {}),
                ...(args.error !== undefined ? { error: args.error } : {}),
                ...(args.needsAttention !== undefined ? { needsAttention: args.needsAttention } : {}),
                ...(args.attentionReason !== undefined ? { attentionReason: args.attentionReason } : {}),
            } as AutomationReport;
            return { run: await client.report(runId, report) };
        }
        case 'automation_ack': return { run: await client.ack(args.runId) };
    }
}

export type AutomationToolExecutor = (name: AutomationToolName, args: any) => Promise<unknown>;

/** Lazily authenticated in-process executor (managed Claude / pi over HAPPY_MCP_URL). */
export function createAutomationToolExecutor(): AutomationToolExecutor {
    let context: Promise<AutomationToolContext> | null = null;
    return async (name, args) => {
        // Re-authenticate after a failure so a later login is picked up.
        context ??= authenticatedAutomationsClient('mcp-auto').then(({ client, machineId }) => ({ client, machineId }));
        let resolved: AutomationToolContext;
        try { resolved = await context; } catch (error) { context = null; throw error; }
        return executeAutomationTool(name, args, resolved);
    };
}

export function registerAutomationTools(server: AssistantToolRegistrar, execute: AutomationToolExecutor = createAutomationToolExecutor()): void {
    for (const name of AUTOMATION_TOOL_NAMES) {
        const spec = AUTOMATION_TOOL_SCHEMAS[name];
        server.registerTool(name, {
            description: spec.description, inputSchema: spec.inputSchema,
            annotations: { readOnlyHint: spec.readOnly === true, idempotentHint: name !== 'automation_run' && name !== 'automation_create', openWorldHint: false, destructiveHint: spec.destructive === true },
        }, async (args: any) => {
            try { return { content: [{ type: 'text' as const, text: JSON.stringify(await execute(name, args ?? {})) }], isError: false }; }
            catch (error) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Automation operation failed' }], isError: true }; }
        });
    }
}
