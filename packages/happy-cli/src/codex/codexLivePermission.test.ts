/**
 * B-867c wiring: the Codex wrapper answers `set-permission-mode` (operator
 * controls; QA40 P2-5 got machine_offline because nothing was registered),
 * validates the mode against the Codex set, makes it the next turn's mode,
 * publishes it, and advertises codex-live-permission-v1 so the server can
 * refuse older wrappers at once. The validation is codexPublishablePermissionMode
 * (codexPermissionMode.test.ts). Source assertions, verified with
 * scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const codex = readFileSync(new URL('./runCodex.ts', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');

describe('B-867c Codex live permission mode', () => {
    it('registers set-permission-mode: validated, sticky for the next turn, published', () => {
        expect(codex).toContain("registerHandler<{ mode?: unknown }, { mode: PermissionMode }>('set-permission-mode', async (request) => {\n        const mode = codexPublishablePermissionMode(request?.mode);\n        if (!mode) throw new Error('Invalid Codex permission mode');\n        currentPermissionMode = mode;\n        publishPermissionMode(mode);\n        return { mode };");
    });

    it('advertises the capability', () => {
        expect(codex).toContain('CODEX_BTW_CAPABILITY, CODEX_LIVE_PERMISSION_CAPABILITY],');
    });

    it('a message without a mode runs the live-set one', () => {
        expect(codex).toContain('let messagePermissionMode = currentPermissionMode;');
    });
});
