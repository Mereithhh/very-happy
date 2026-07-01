// Shim: voice is intentionally cut in very-happy web v2 (no purchase flow, self-hosted).
// The data layer calls these on session lifecycle events; here they are no-ops.
import type { Metadata } from '@/sync/storageTypes';
import type { NormalizedMessage } from '@/sync/typesMessage';

export const voiceHooks = {
  onSessionFocus(_sessionId: string, _metadata?: Metadata) {},
  onPermissionRequested(
    _sessionId: string,
    _requestId: string,
    _toolName: string,
    _args?: unknown,
  ) {},
  onMessages(_sessionId: string, _messages: NormalizedMessage[]) {},
  onReady(_sessionId: string) {},
  onSessionOffline(_sessionId: string, _metadata?: Metadata) {},
  onSessionOnline(_sessionId: string, _metadata?: Metadata) {},
};
