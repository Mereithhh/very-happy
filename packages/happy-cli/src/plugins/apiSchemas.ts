/**
 * B-974c: request bodies of `/plugin/v1` (DESIGN §5.2–§5.4). Local draft of
 * the wire schemas (B-974a); same limits.
 */
import { z } from 'zod';

const NO_CONTROL = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const SINGLE_LINE = /^[^\u0000-\u001f\u007f\u2028\u2029]*$/;
const ACTION_ID = /^[a-z0-9_-]{1,16}$/;
const kb = (n: number) => n * 1024;
const byteMax = (n: number) => (s: string) => Buffer.byteLength(s, 'utf8') <= n;

export const BadgePutSchema = z.object({
    count: z.number().int().min(0).max(9999).nullable(),
    tone: z.enum(['default', 'attention']).optional(),
    label: z.string().max(16).regex(SINGLE_LINE).optional(),
}).strict();

const OptionSchema = z.object({
    id: z.string().regex(ACTION_ID),
    label: z.string().min(1).max(40).regex(SINGLE_LINE),
    style: z.enum(['default', 'primary', 'danger']).optional(),
    detail: z.string().max(200).regex(NO_CONTROL).optional(),
}).strict();
const InputSchema = z.object({
    placeholder: z.string().max(80).regex(SINGLE_LINE).optional(),
    maxLength: z.number().int().min(1).max(2000).optional(),
    multiline: z.boolean().optional(),
}).strict();

const panelPath = z.string().max(512).startsWith('/');

export const DecisionPostSchema = z.object({
    key: z.string().min(1).max(256),
    kind: z.enum(['choice', 'input', 'notice']),
    title: z.string().min(1).max(120).regex(SINGLE_LINE),
    bodyMd: z.string().refine(byteMax(kb(8)), 'bodyMd is limited to 8KB').optional(),
    options: z.array(OptionSchema).min(2).max(4).optional(),
    input: InputSchema.optional(),
    sessionId: z.string().min(1).max(128).optional(),
    panelPath: panelPath.optional(),
    push: z.boolean().optional(),
}).strict().superRefine((d, ctx) => {
    if (d.kind === 'choice' && !d.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'choice needs 2–4 options' });
    if (d.kind !== 'choice' && d.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'only choice takes options' });
    if (d.kind === 'input' && !d.input) ctx.addIssue({ code: 'custom', path: ['input'], message: 'input needs "input"' });
    if (d.kind !== 'input' && d.input) ctx.addIssue({ code: 'custom', path: ['input'], message: 'only input takes "input"' });
    if (d.options && new Set(d.options.map((o) => o.id)).size !== d.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'duplicate option id' });
});

export const DecisionPatchSchema = z.object({
    title: z.string().min(1).max(120).regex(SINGLE_LINE).optional(),
    bodyMd: z.string().refine(byteMax(kb(8)), 'bodyMd is limited to 8KB').optional(),
    options: z.array(OptionSchema).min(2).max(4).optional(),
    input: InputSchema.optional(),
    panelPath: panelPath.optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

export const DecisionDeleteSchema = z.object({
    outcome: z.enum(['done', 'dropped', 'superseded']).optional(),
    note: z.string().max(500).optional(),
}).strict();

export const WidgetPutSchema = z.object({
    status: z.object({
        label: z.string().min(1).max(24).regex(SINGLE_LINE),
        tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger']),
    }).strict(),
    text: z.string().max(280).optional(),
    actions: z.array(z.object({
        id: z.string().regex(ACTION_ID),
        label: z.string().min(1).max(20).regex(SINGLE_LINE),
        style: z.enum(['default', 'primary', 'danger']).optional(),
        confirm: z.string().max(120).optional(),
    }).strict()).max(2).optional(),
    panelPath: panelPath.optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

export const EventsAckSchema = z.object({ upTo: z.union([z.string().regex(/^\d{1,15}$/), z.number().int().nonnegative()]) }).strict();

export function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
    return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
