import type { PermissionMode } from '@/api/types';

// Absence of a permission option must never mean full machine access. Existing
// Web devices that explicitly send their historical auto-apply preference keep
// it; fresh/older clients and direct CLI invocations fall back to approval.
export const DEFAULT_CLAUDE_PERMISSION_MODE: PermissionMode = 'default';
export const DEFAULT_CODEX_PERMISSION_MODE: PermissionMode = 'default';
