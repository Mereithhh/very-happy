import { describe, expect, it } from 'vitest';
import {
    normalizeClaudeOutboundMode,
    sanitizeAgentDefaultOverrides,
    sanitizeSessionPermissionModes,
} from './permissionModeOutbound';

describe('normalizeClaudeOutboundMode (B-262 A1)', () => {
    it('passes the four CLI-known modes through and maps yolo to bypassPermissions', () => {
        expect(normalizeClaudeOutboundMode('default')).toBe('default');
        expect(normalizeClaudeOutboundMode('acceptEdits')).toBe('acceptEdits');
        expect(normalizeClaudeOutboundMode('plan')).toBe('plan');
        expect(normalizeClaudeOutboundMode('bypassPermissions')).toBe('bypassPermissions');
        expect(normalizeClaudeOutboundMode('yolo')).toBe('bypassPermissions');
    });
    it('maps the dead dontAsk option (and anything unknown) to default — never widens permissions', () => {
        expect(normalizeClaudeOutboundMode('dontAsk')).toBe('default');
        expect(normalizeClaudeOutboundMode('auto')).toBe('default');
        expect(normalizeClaudeOutboundMode('')).toBe('default');
    });
    it('keeps null/undefined as null (caller decides whether to send anything)', () => {
        expect(normalizeClaudeOutboundMode(null)).toBeNull();
        expect(normalizeClaudeOutboundMode(undefined)).toBeNull();
    });
});

describe('sanitizeAgentDefaultOverrides', () => {
    it('returns null when nothing needs rewriting (no extra settings POST)', () => {
        expect(sanitizeAgentDefaultOverrides(undefined)).toBeNull();
        expect(sanitizeAgentDefaultOverrides({})).toBeNull();
        expect(sanitizeAgentDefaultOverrides({ claude: { permissionMode: 'bypassPermissions', modelMode: 'x' } })).toBeNull();
        expect(sanitizeAgentDefaultOverrides({ codex: { permissionMode: 'yolo' } })).toBeNull(); // codex vocab untouched
    });
    it('returns the FULL overrides object with only the claude value rewritten', () => {
        const next = sanitizeAgentDefaultOverrides({
            claude: { permissionMode: 'dontAsk', modelMode: 'opus' },
            codex: { permissionMode: 'read-only' },
        });
        expect(next).toEqual({
            claude: { permissionMode: 'default', modelMode: 'opus' },
            codex: { permissionMode: 'read-only' },
        });
    });
});

describe('sanitizeSessionPermissionModes', () => {
    it('drops dontAsk entries and keeps everything else, same reference when clean', () => {
        const clean = { a: 'bypassPermissions', b: 'plan', c: 'read-only' };
        expect(sanitizeSessionPermissionModes(clean)).toBe(clean);
        expect(sanitizeSessionPermissionModes({ ...clean, d: 'dontAsk' })).toEqual(clean);
    });
});
