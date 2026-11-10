import { describe, expect, it } from 'vitest';
import {
    AttentionItemOwnerRespondSchema, AttentionItemPostSchema, applyWrapupCheck, attentionItemNeedsOwner, attentionPushKind,
    parseWrapupPayload, wrapupInProgress, WRAPUP_RUNNING_STALE_MS,
} from './attention';
import {
    buildHandoffPrompt, buildWrapupPrompt, builtinActionOfLocalId, decodeWrapupConfig, DEFAULT_WRAPUP_TEMPLATE, encodeWrapupConfig,
    handoffLocalId, resolveWrapupTemplate, WRAPUP_PROTOCOL_TAIL, wrapupLocalId,
} from './wrapup';

const done = { v: 1 as const, mode: 'wrapup' as const, status: 'done' as const, summary: 's', pending: [{ id: 'p1', label: 'release?', checked: false }], canClose: false };

describe('B-915 wrap-up contract', () => {
    it('post: payload required for wrapup and rejected elsewhere', () => {
        expect(AttentionItemPostSchema.safeParse({ sessionId: 's', source: 'agent', kind: 'wrapup', title: 't', payload: done }).success).toBe(true);
        expect(AttentionItemPostSchema.safeParse({ sessionId: 's', source: 'agent', kind: 'wrapup', title: 't' }).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ sessionId: 's', source: 'lead', kind: 'report', title: 't', payload: done }).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ sessionId: 's', source: 'agent', kind: 'wrapup', title: 't', payload: { ...done, commits: [{ sha: 'zz' }] } }).success).toBe(false);
    });
    it('needsOwner: running wrap-up waits on nobody, a result does; never pushes', () => {
        expect(attentionItemNeedsOwner('wrapup', { ...done, status: 'running' })).toBe(false);
        expect(attentionItemNeedsOwner('wrapup', done)).toBe(true);
        expect(attentionItemNeedsOwner('report', undefined)).toBe(false);
        expect(attentionItemNeedsOwner('decision', undefined)).toBe(true);
        expect(attentionPushKind({ kind: 'wrapup' })).toBeNull();
    });
    it('check action and applyWrapupCheck', () => {
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'check', checkId: 'p1', checked: true }).success).toBe(true);
        expect(applyWrapupCheck(done, 'p1', true)).toMatchObject({ pending: [{ id: 'p1', checked: true }] });
        expect(applyWrapupCheck(done, 'nope', true)).toBeNull();
        expect(applyWrapupCheck(null, 'p1', true)).toBeNull();
    });
    it('wrapupInProgress: running + fresh + same mode only', () => {
        const now = 10 * WRAPUP_RUNNING_STALE_MS;
        const item = { kind: 'wrapup', state: 'open', updatedAt: now, payload: { v: 1, mode: 'wrapup', status: 'running', startedAt: now - 1000 } };
        expect(wrapupInProgress(item, 'wrapup', now)).toBe(true);
        expect(wrapupInProgress(item, 'handoff', now)).toBe(false);
        expect(wrapupInProgress({ ...item, payload: { ...item.payload, startedAt: now - WRAPUP_RUNNING_STALE_MS } }, 'wrapup', now)).toBe(false);
        expect(wrapupInProgress({ ...item, state: 'dismissed' }, 'wrapup', now)).toBe(false);
        expect(wrapupInProgress({ ...item, payload: done }, 'wrapup', now)).toBe(false);
        expect(wrapupInProgress(null, 'wrapup', now)).toBe(false);
    });
    it('parseWrapupPayload tolerates unknown values and rejects non-v1', () => {
        expect(parseWrapupPayload({ v: 1, mode: 'future', status: 'x', extra: 1 })?.mode).toBe('future');
        expect(parseWrapupPayload({ v: 2 })).toBeNull();
        expect(parseWrapupPayload(null)).toBeNull();
    });
    it('KV config round-trips (unicode) and falls back on garbage', () => {
        const v = encodeWrapupConfig({ template: '收尾：做了什么 ✓', lang: 'zh' });
        expect(decodeWrapupConfig(v)).toEqual({ template: '收尾：做了什么 ✓', lang: 'zh' });
        expect(decodeWrapupConfig('%%%')).toEqual({ template: null });
        expect(decodeWrapupConfig(null)).toEqual({ template: null });
    });
    it('template resolution and prompts', () => {
        expect(resolveWrapupTemplate({ template: '  ' }, 'en')).toBe(DEFAULT_WRAPUP_TEMPLATE.en);
        expect(resolveWrapupTemplate({ template: null, lang: 'zh' }, 'en')).toBe(DEFAULT_WRAPUP_TEMPLATE.zh);
        expect(resolveWrapupTemplate({ template: 'mine' }, 'zh')).toBe('mine');
        expect(buildWrapupPrompt('mine')).toBe(`mine\n\n${WRAPUP_PROTOCOL_TAIL}`);
        const h = buildHandoffPrompt({ to: { id: 'abc', title: 'Target', machineId: 'm1' }, archiveAfter: true, note: 'hi' });
        expect(h).toContain('to: "abc", machine_id: "m1"');
        expect(h).toContain('archive_after: true');
        expect(h).toContain('Note from the user: hi');
    });
    it('default templates are generic', () => {
        for (const t of Object.values(DEFAULT_WRAPUP_TEMPLATE)) expect(t).not.toMatch(/skill|commit push|沉淀/i);
    });
    it('localId prefixes', () => {
        expect(builtinActionOfLocalId(wrapupLocalId('n'))).toBe('wrapup');
        expect(builtinActionOfLocalId(handoffLocalId('n'))).toBe('handoff');
        expect(builtinActionOfLocalId('board-x')).toBeNull();
        expect(builtinActionOfLocalId(undefined)).toBeNull();
    });
});
