import { describe, expect, it } from 'vitest';
import { classifyConfigReadError, codexConfigReportFields } from './codexConfigReport';

function rpcError(message: string, code: number): Error {
    // Shape CodexAppServerClient rejects with for a JSON-RPC error response.
    const error = new Error(`config/read: ${message} (code=${code})`);
    (error as Error & { jsonRpcCode?: number }).jsonRpcCode = code;
    return error;
}

const LEGACY = 'failed to resolve feature override precedence: legacy `profile = "x"` config is no longer supported; use `--profile x` with `x.config.toml` instead';

describe('B-971b codexConfigReport', () => {
    it('reports the machine config model on success and clears an earlier error', () => {
        expect(codexConfigReportFields({ model: 'deepseek-v4-flash' })).toEqual({ machineConfigModel: 'deepseek-v4-flash', configReadError: undefined });
        const nothingPinned = codexConfigReportFields({ model: null });
        expect(nothingPinned.machineConfigModel).toBeNull();
        expect('configReadError' in nothingPinned).toBe(true);
        expect(JSON.parse(JSON.stringify({ configReadError: { kind: 'failed', reason: 'x' }, ...nothingPinned }))).toEqual({ machineConfigModel: null });
    });

    it('classifies Codex 0.172 legacy profile refusal (-32603) with its one-line reason', () => {
        expect(classifyConfigReadError(rpcError(LEGACY, -32603))).toEqual({ kind: 'legacyProfile', reason: LEGACY });
    });

    it('drops echoed values and directories from other config errors (Codex 0.172 messages)', () => {
        expect(classifyConfigReadError(rpcError('invalid configuration: invalid type: string "sk-test-0000secret", expected a map\nin `model_providers.x.http_headers`\n', -32603)))
            .toEqual({ kind: 'invalidConfig', reason: 'invalid configuration: invalid type: string "…", expected a map in `model_providers.x.http_headers`' });
        expect(classifyConfigReadError(rpcError('invalid configuration: invalid type: integer `5`, expected a string\nin `model`\n', -32603))?.reason)
            .toBe('invalid configuration: invalid type: integer `…`, expected a string in `model`');
        expect(classifyConfigReadError(rpcError('invalid configuration: unknown variant `sk-test-0000`, expected one of `read-only`, `workspace-write`\nin `sandbox_mode`\n', -32603))?.reason)
            .toBe('invalid configuration: unknown variant `…`, expected one of `read-only`, `workspace-write` in `sandbox_mode`');
        expect(classifyConfigReadError(rpcError('failed to read configuration layers: /home/someone/.codex/config.toml:2:7: string values must be quoted, expected literal string', -32603))?.reason)
            .toBe('failed to read configuration layers: config.toml:2:7: string values must be quoted, expected literal string');
    });

    it('classifies other JSON-RPC errors as invalid config and keeps one capped line', () => {
        const long = `bad toml: ${'a'.repeat(400)} secret = "do-not-leak"`;
        const report = classifyConfigReadError(rpcError(long, -32603));
        expect(report?.kind).toBe('invalidConfig');
        expect(report?.reason).not.toContain('do-not-leak');
        expect(report?.reason.length).toBeLessThanOrEqual(200);
    });

    it('treats a missing config/read (older Codex) as unknown, not an error', () => {
        expect(classifyConfigReadError(rpcError('Method not found', -32601))).toBeNull();
        expect(codexConfigReportFields({ error: rpcError('Method not found', -32601) })).toEqual({ machineConfigModel: undefined, configReadError: undefined });
    });

    it('reports a timeout / disconnect as failed', () => {
        expect(classifyConfigReadError(new Error('config/read timed out after 10000ms (id=3)'))).toEqual({ kind: 'failed', reason: 'config/read timed out after 10000ms (id=3)' });
        expect(codexConfigReportFields({ error: 'boom' }).configReadError).toEqual({ kind: 'failed', reason: 'boom' });
    });
});
