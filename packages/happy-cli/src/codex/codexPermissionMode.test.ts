import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexPublishablePermissionMode } from './codexPermissionMode';

describe('B-845 Codex publishes the permission mode a resume relaunches with', () => {
    it('publishes Codex modes, nothing else', () => {
        for (const mode of ['default', 'read-only', 'safe-yolo', 'yolo']) expect(codexPublishablePermissionMode(mode)).toBe(mode);
        expect(codexPublishablePermissionMode('bypassPermissions')).toBeNull();
        expect(codexPublishablePermissionMode('totally_unsafe')).toBeNull();
        expect(codexPublishablePermissionMode(undefined)).toBeNull();
    });

    it('wiring: the explicit flag and every accepted message mode are published; the code default is not', () => {
        const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
        expect(source).toContain('    publishPermissionMode(opts.permissionMode);');
        expect(source).not.toContain('publishPermissionMode(initialPermissionMode)');
        expect(source).toContain([
            '                    messagePermissionMode = incoming;',
            '                    currentPermissionMode = messagePermissionMode;',
            '                    publishPermissionMode(incoming);',
        ].join('\n'));
        expect(source).toContain("session.updateMetadata((currentMetadata) => ({ ...currentMetadata, permissionMode: publishable }));");
    });
});

describe('B-845 Codex /clear re-sends the full project prefix', () => {
    it('resets the project injector in the /clear branch', () => {
        const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
        const clear = source.slice(source.indexOf('if (isCodexClearText(message.message)) {'), source.indexOf("messageBuffer.addMessage('Context was reset', 'status');"));
        expect(clear).toContain('projectInjector.reset();');
    });
});
