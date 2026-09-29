/**
 * B-512: the half of `runClaude` that is only needed AFTER the session exists
 * and the daemon webhook has been sent — the SDK loop (claude-agent-sdk, ink),
 * the MCP server, the hook server, the scanners and the per-session helpers.
 *
 * `runClaude` starts `import('./runClaudeDeps')` early and awaits it right after
 * `notifyDaemonSessionStarted`, so loading this graph overlaps with the
 * session-create round trip instead of delaying the webhook the daemon's spawn
 * RPC is waiting for. Keep pre-webhook code OUT of this barrel and keep
 * post-webhook-only imports IN it (a static import in runClaude.ts would drag
 * the module back onto the critical path).
 */
export { loop } from './loop';
export { MessageQueue2 } from '@/utils/MessageQueue2';
export { claudeModeHash } from './claudeModeHash';
export { parseSpecialCommand } from '@/parsers/specialCommands';
export { getEnvironmentInfo } from '@/ui/doctor';
export { startHappyServer } from '@/claude/utils/startHappyServer';
export { startHookServer } from '@/claude/utils/startHookServer';
export { EditReportThrottle, extractClaudeEditPaths } from '@/sessions/editPaths';
export { reportSessionEditToDaemon } from '@/daemon/controlClient';
export { generateHookSettingsFile, cleanupHookSettingsFile } from '@/claude/utils/generateHookSettings';
export { registerKillSessionHandler } from './registerKillSessionHandler';
export { SessionExitGate, exitIntentFromArchiveFlag, settleSessionOnExit } from './sessionExitLifecycle';
export { registerSideQuestionHandler, writeSideQuestionSettingsFile } from './registerSideQuestionHandler';
export { claudeCheckSession } from '@/claude/utils/claudeCheckSession';
export { createSessionScanner } from '@/claude/utils/sessionScanner';
export { getProjectPath } from './utils/path';
export { RawJSONLinesSchema } from './types';
export { TitleGenerator } from './utils/titleGenerator';
export { BoardAnalyzer, FileRateLimiter } from './utils/boardAnalyzer';
export { createSelfReportState } from './utils/boardReport';
export { withAssistantDenylist } from '@/assistant/dispatcherTools';
export { contentLogMetadata } from '@/utils/contentLogMetadata';
