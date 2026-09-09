/** Web adapter; data semantics are shared with the official Todo CLI. */
import { createBuiltinTodoClient as createClient, type BuiltinTodoClientOptions } from '@slopus/happy-wire';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
export { BUILTIN_TODO_PREFIX, TITLE_MAX_LENGTH, NOTE_MAX_LENGTH, MAX_COUNT, BuiltinTodoError, parseBuiltinTodo, encodeBuiltinTodo, decodeBuiltinTodo, sortBuiltinTodos } from '@slopus/happy-wire';
export type { BuiltinTodo, BuiltinTodoRecord, BuiltinTodoPatch, BuiltinTodoList, BuiltinTodoErrorCode, BuiltinTodoClient, BuiltinTodoClientOptions } from '@slopus/happy-wire';
export function createBuiltinTodoClient(credentials: AuthCredentials, options: Partial<BuiltinTodoClientOptions> = {}) {
    return createClient(credentials, { ...options, serverUrl: options.serverUrl ?? getServerUrl(), clientId: options.clientId ?? getHappyClientId() });
}
