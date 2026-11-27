import { z } from 'zod';

/**
 * B-980 model-answer feedback and model-request tagging
 * (`specs/2026-11-model-feedback.md`).
 *
 * Everything deployment-specific (which gateway hosts get tagged, the header
 * names, where feedback is forwarded) comes from the operator's instance
 * config file on the server; nothing here names a gateway.
 */

/** HTTP header names: RFC 7230 token characters only, so a value can never smuggle a second header. */
export const HttpHeaderNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);

/**
 * Which model requests the CLI tags, and with which headers. `hosts` are exact
 * host names or `*.suffix` patterns, matched against the account's base URL;
 * global model channels are always tagged while tagging is on.
 */
export const ModelRequestTaggingSchema = z.object({
    sessionHeader: HttpHeaderNameSchema,
    requestHeader: HttpHeaderNameSchema,
    hosts: z.array(z.string().min(1).max(253)).max(64).default([]),
});
export type ModelRequestTagging = z.infer<typeof ModelRequestTaggingSchema>;

/** `tagged`: buttons only under answers whose turn sent tagged requests. `all`: under every final answer. */
export const ModelFeedbackScopeSchema = z.enum(['tagged', 'all']);
export type ModelFeedbackScope = z.infer<typeof ModelFeedbackScopeSchema>;

/**
 * `GET /v1/instance/config`: the client-facing part of the instance config.
 * Readers must treat every field as optional; an older server answers 404.
 */
export const InstanceClientConfigSchema = z.object({
    modelRequestTagging: ModelRequestTaggingSchema.nullable().optional(),
    modelFeedback: z.object({ enabled: z.boolean(), scope: ModelFeedbackScopeSchema.catch('tagged') }).nullable().optional(),
});
export type InstanceClientConfig = z.infer<typeof InstanceClientConfigSchema>;

export const INSTANCE_CONFIG_PATH = '/v1/instance/config';

/** True when `host` (lower-cased, no port) is listed exactly or under a `*.suffix` pattern. */
export function hostMatchesTagging(host: string, patterns: readonly string[]): boolean {
    const h = host.trim().toLowerCase().replace(/\.$/, '');
    if (!h) return false;
    return patterns.some(raw => {
        const p = raw.trim().toLowerCase().replace(/\.$/, '');
        if (!p) return false;
        if (p.startsWith('*.')) {
            const suffix = p.slice(1); // ".example.com"
            return h.endsWith(suffix) && h.length > suffix.length;
        }
        return h === p;
    });
}

export const ModelFeedbackRatingSchema = z.enum(['up', 'down']);
export type ModelFeedbackRating = z.infer<typeof ModelFeedbackRatingSchema>;

const Id = z.string().min(1).max(128);

/** `PUT /v1/model-feedback`: one rating per (account, session, turn); a resend replaces it. */
export const ModelFeedbackSubmitSchema = z.object({
    sessionId: Id,
    turnId: Id,
    rating: ModelFeedbackRatingSchema,
    comment: z.string().max(2000).optional(),
    /** Request ids the CLI put on this turn's model requests (turn-end `modelRequestIds`). */
    requestIds: z.array(z.string().min(1).max(128)).max(200).default([]),
    /** Requested and actually reported model, as the session showed them. */
    model: z.string().max(200).nullable().optional(),
    reportedModel: z.string().max(200).nullable().optional(),
    /** Session agent flavor (`claude`, `codex`, …). */
    agent: z.string().max(32).nullable().optional(),
    /** The account the session ran on: its id, label and kind (no secrets). */
    accountProfile: z.object({ id: z.string().max(128), label: z.string().max(200).optional(), kind: z.string().max(64).optional() }).nullable().optional(),
    /** Server seq of the rated answer, for jumping back to it. */
    messageSeq: z.number().int().nonnegative().nullable().optional(),
    answeredAt: z.number().int().nonnegative().nullable().optional(),
});
export type ModelFeedbackSubmit = z.infer<typeof ModelFeedbackSubmitSchema>;

export const ModelFeedbackViewSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    rating: ModelFeedbackRatingSchema,
    comment: z.string().nullable(),
    updatedAt: z.number(),
});
export type ModelFeedbackView = z.infer<typeof ModelFeedbackViewSchema>;

/**
 * One exported / forwarded record. Field names are stable: downstream joins
 * use `sessionId` (the value of the session header) and `requestIds` (values
 * of the request header).
 */
export const ModelFeedbackRecordSchema = z.object({
    id: z.string(),
    accountId: z.string(),
    account: z.object({ username: z.string().nullable(), displayName: z.string().nullable(), email: z.string().nullable() }).optional(),
    sessionId: z.string(),
    turnId: z.string(),
    rating: ModelFeedbackRatingSchema,
    comment: z.string().nullable(),
    requestIds: z.array(z.string()),
    model: z.string().nullable(),
    reportedModel: z.string().nullable(),
    agent: z.string().nullable(),
    accountProfile: z.object({ id: z.string(), label: z.string().optional(), kind: z.string().optional() }).nullable(),
    messageSeq: z.number().nullable(),
    answeredAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type ModelFeedbackRecord = z.infer<typeof ModelFeedbackRecordSchema>;
