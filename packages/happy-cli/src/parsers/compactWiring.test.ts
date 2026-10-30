/**
 * Owner 10-30 (/compact answered by the model: "I can't run that") — where each
 * runner takes a standalone /compact before it could become chat. The behaviour
 * lives in pure modules with their own tests (finalizeRemotePrompt,
 * codexCompact, acpSlashCommand.routeAcpUserText); these pin the call sites.
 * Source assertions (comments stripped), verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');

describe('/compact wiring', () => {
    it('Codex compacts through the app-server before any turn prompt is built', () => {
        const codex = read('codex/runCodex.ts');
        const compactAt = codex.indexOf('const compactCommand = codexCompactCommand(message.message);');
        expect(compactAt).toBeGreaterThan(0);
        const branch = codex.slice(compactAt, codex.indexOf('const turnPrompt = buildCodexTurnPrompt({'));
        expect(branch).toContain('if (compactCommand !== null) {');
        expect(branch).toContain('const outcome = await runCodexCompact(compactCommand, {');
        expect(branch).toContain("session.sendSessionEvent({ type: 'message', message: text });");
        expect(branch).toMatch(/logger\.debug\(`\[Codex\] \/compact \$\{outcome\}`\);\s*continue;/);
    });

    it('ACP routes /compact before steering or queueing it', () => {
        const acp = read('agent/acp/runAcp.ts');
        const routeAt = acp.indexOf('const route = routeAcpUserText(message.content.text, agentCommands);');
        const steerAt = acp.indexOf("if (message.meta?.delivery === 'steer' && piSteer?.ready && thinking && !attachments?.length) {");
        expect(routeAt).toBeGreaterThan(0);
        expect(steerAt).toBeGreaterThan(routeAt);
        const branch = acp.slice(routeAt, steerAt);
        expect(branch).toContain("if (route.kind === 'unsupported') {\n        session.sendSessionEvent({ type: 'message', message: route.notice });\n        return;");
        expect(branch).toContain("if (route.kind === 'command') {\n        messageQueue.pushIsolate(route.text, {");
        expect(acp).toContain('agentCommands = commandNames;');
    });

    it('Gemini and OpenClaw answer /compact themselves', () => {
        for (const path of ['gemini/runGemini.ts', 'openclaw/runOpenClaw.ts']) {
            const src = read(path);
            const at = src.indexOf('session.onUserMessage((message) => {');
            expect(src.slice(at, at + 400)).toMatch(/if \(compactCommandText\(message\.content\.text[^)]*\) !== null\) \{\s*session\.sendSessionEvent\(\{ type: 'message', message: COMPACT_UNSUPPORTED_NOTICE \}\);\s*return;/);
        }
    });

    it('Claude finalizes the prompt through the helper that leaves /compact bare', () => {
        const launcher = read('claude/claudeRemoteLauncher.ts');
        expect(launcher).toContain('const out = await finalizeRemotePrompt(prompt, {');
        expect(read('claude/finalizeRemotePrompt.ts')).toContain("if (command === 'compact' || command === 'clear') return prompt;");
    });

    it('Claude spends one-time start flags (--resume) only after a launch ran Claude on them (QA21)', () => {
        const launcher = read('claude/claudeRemoteLauncher.ts');
        expect(launcher).toContain('onStartArgsUsed: () => { startArgsUsed = true; },');
        expect(launcher).toContain('if (startArgsUsed) session.consumeOneTimeFlags();');
        expect(launcher.match(/consumeOneTimeFlags\(\)/g)).toHaveLength(1);
    });
});
