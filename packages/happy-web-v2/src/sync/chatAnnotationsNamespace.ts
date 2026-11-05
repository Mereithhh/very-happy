/**
 * B-891: MMKV namespace of the transcript comment drafts (screens/session/chatAnnotations).
 * Its own module so the store does not import sync/persistence (component tests mock that
 * module wholesale) while logout / session deletion there can still clear it.
 */
export const CHAT_ANNOTATIONS_MMKV_ID = 'chat-annotations';
export const chatAnnotationsKey = (sessionId: string) => `s.${sessionId}`;
