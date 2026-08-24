import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(process.cwd(), 'sources');
const GUARDED_FILES = [
    'main.ts',
    'modules/github.ts',
    'app/auth/auth.ts',
    'app/github/githubDisconnect.ts',
    'app/presence/sessionCache.ts',
    'app/push/pushDispatch.ts',
    'app/push/webPush.ts',
    'app/push/webhookNotify.ts',
    'app/api/socket.ts',
    'app/api/socket/accessKeyHandler.ts',
    'app/api/socket/artifactUpdateHandler.ts',
    'app/api/socket/machineUpdateHandler.ts',
    'app/api/socket/rpcHandler.ts',
    'app/api/socket/sessionUpdateHandler.ts',
    'app/api/socket/usageHandler.ts',
    'app/api/routes/accessKeysRoutes.ts',
    'app/api/routes/accountAuthRoutes.ts',
    'app/api/routes/accountRoutes.ts',
    'app/api/routes/artifactsRoutes.ts',
    'app/api/routes/connectRoutes.ts',
    'app/api/routes/feedRoutes.ts',
    'app/api/routes/kvRoutes.ts',
    'app/api/routes/sessionRoutes.ts',
    'app/api/routes/unlockRoutes.ts',
    'app/api/routes/voiceRoutes.ts',
    'app/api/utils/enableAuthentication.ts',
    'app/api/utils/enableErrorHandlers.ts',
    'app/api/utils/enableMonitoring.ts',
];

function readSource(relativePath: string): string {
    return readFileSync(join(SOURCE_ROOT, relativePath), 'utf8');
}

function logCalls(source: string): string[] {
    const calls: string[] = [];
    const matcher = /\blog\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(source))) {
        // All production log statements are semicolon-terminated. A bounded
        // slice prevents one malformed statement from hiding the whole file.
        const end = source.indexOf(';', match.index);
        calls.push(source.slice(match.index, end < 0 ? match.index + 2_000 : Math.min(end + 1, match.index + 2_000)));
    }
    return calls;
}

describe('server log source guard', () => {
    it('does not interpolate linkable ids, content, provider details, or raw errors', () => {
        const sensitiveInterpolation = /\$\{[^}]*\b(?:accountId|conversationId|detail|endpoint|error|machineId|message|payload|reason|room|sessionId|socket(?:\.id)?|tag|userId|voiceId)\b/i;
        const rawErrorMember = /\.(?:detail|message|reason|stack)(?:\b|\s*\()/i;
        for (const relativePath of GUARDED_FILES) {
            for (const call of logCalls(readSource(relativePath))) {
                expect(call, relativePath).not.toMatch(sensitiveInterpolation);
                expect(call, relativePath).not.toMatch(rawErrorMember);
                expect(call, relativePath).not.toMatch(/JSON\.stringify\s*\(\s*(?:error|errors|payload|response)/i);
            }
        }
    });

    it('keeps fatal process logging on the sanitizer path', () => {
        const main = readSource('main.ts');
        expect(main).not.toMatch(/console\.(?:error|warn|log)\s*\(/);
        expect(main).not.toContain('error.stack');
        expect(main).not.toContain('error.message');
        expect(main).not.toContain('String(reason)');
    });

    it('contains no built-in privileged voice account id', () => {
        const voice = readSource('app/api/routes/voiceRoutes.ts');
        expect(voice).not.toContain('VOICE_EXTRA_LIMIT_PUBLIC_IDS');
        expect(voice).toContain('VOICE_EXTRA_LIMIT_ACCOUNT_IDS');
        expect(voice).toContain('resolveVoiceExtraLimitAccountIds');
    });

    it('routes default logger arguments through the sanitizer', () => {
        const logger = readSource('utils/log.ts');
        expect(logger.match(/sanitizeLogArgument\(src\)/g)).toHaveLength(4);
        expect(logger.match(/args\.map\(sanitizeLogArgument\)/g)).toHaveLength(4);
    });
});
