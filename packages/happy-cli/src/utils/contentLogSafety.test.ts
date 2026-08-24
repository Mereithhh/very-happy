import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

function readSource(relativePath: string): string {
    return readFileSync(new URL(relativePath, `file://${sourceRoot}/`), 'utf8');
}

describe('content log call sites', () => {
    it('does not restore known prompt, response, tool, or hook body logging', () => {
        const sources = [
            readSource('agent/acp/AcpBackend.ts'),
            readSource('agent/acp/sessionUpdateHandlers.ts'),
            readSource('gemini/runGemini.ts'),
            readSource('claude/runClaude.ts'),
            readSource('claude/claudeRemote.ts'),
            readSource('claude/claudeRemoteLauncher.ts'),
            readSource('claude/utils/permissionHandler.ts'),
            readSource('codex/codexAppServerClient.ts'),
            readSource('api/pushNotifications.ts'),
            readSource('openclaw/runOpenClaw.ts'),
            readSource('openclaw/OpenClawSocket.ts'),
            readSource('openclaw/OpenClawBackend.ts'),
            readSource('claude/claudeLocal.ts'),
        ].join('\n');

        const forbiddenFragments = [
            'Permission request: tool=',
            'Incoming raw session update',
            'Full prompt:',
            'Investigation tool FAILED - full content',
            'Investigation objective:',
            'Tool call error: ${errorMsg',
            'first 200 chars:',
            'Thinking chunk received: ${thinkingText.length} chars - Preview:',
            "debugLargeJson('[start] /compact command pushed to queue:', message)",
            "debugLargeJson('[start] /clear command pushed to queue:', message)",
            "debugLargeJson('User message pushed to queue:', message)",
            'Completion event: ${message}',
            'Permission response: ${JSON.stringify(message)}',
            "Non-JSON line:', line.substring",
            "Unhandled message:', JSON.stringify(msg)",
            'sendToAllDevices called with title:',
            'Backend message: ${JSON.stringify(msg)',
            'Incoming prompt: ${batch.message',
            '[CodexAppServer:stderr] ${text}',
            'Non-JSON line from fd3: ${line}',
            "logger.debug('Plan mode result received', response)",
            "logger.warn('[AcpBackend] Error in message handler:', error)",
            'Connecting to gateway: ${url}',
            'WebSocket error: ${err.message}',
            'WebSocket closed: ${code} ${reason.toString()}',
            'Using device ID: ${identity.deviceId',
            'Connected! Server: ${this.serverHost}',
            'Connect failed: ${errorMsg}',
            'Invalid JSON: ${data.slice',
            'Received challenge nonce: ${nonce.slice',
            'Session started: ${sessionId}',
            'Sent prompt, runId: ${result.runId}',
        ];

        for (const fragment of forbiddenFragments) {
            expect(sources, `forbidden logging fragment: ${fragment}`).not.toContain(fragment);
        }
    });
});
