import { describe, expect, it } from 'vitest';
import { DEFAULT_CLAUDE_PERMISSION_MODE, DEFAULT_CODEX_PERMISSION_MODE } from './defaultPermissionMode';

describe('fresh CLI permission defaults', () => {
    it('never treats an omitted mode as bypass/yolo', () => {
        expect(DEFAULT_CLAUDE_PERMISSION_MODE).toBe('default');
        expect(DEFAULT_CODEX_PERMISSION_MODE).toBe('default');
        expect([DEFAULT_CLAUDE_PERMISSION_MODE, DEFAULT_CODEX_PERMISSION_MODE])
            .not.toContain('yolo');
    });
});
