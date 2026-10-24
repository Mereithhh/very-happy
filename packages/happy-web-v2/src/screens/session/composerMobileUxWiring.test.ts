/**
 * B-563 / B-568 wiring (source assertions, comments stripped first; verified
 * with scripts/dev/mutation-check.mjs).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('B-563 the pending-request dock sits above the composer', () => {
    const screen = read('./SessionDetailScreen.tsx');
    const chatList = read('./ChatList.tsx');
    it('renders PermissionCard in the foot between the sub-agent strip and the composer', () => {
        const dock = screen.indexOf('{session && <PermissionCard key={`permission:${id}`} sessionId={id} />}');
        expect(dock).toBeGreaterThan(screen.indexOf('{session && <SubagentDock sessionId={id} />}'));
        expect(dock).toBeLessThan(screen.indexOf('<AgentInput\n'));
        expect(dock).toBeGreaterThan(screen.indexOf('<div className="sd-foot">'));
    });
    it('keeps only a pointer in the transcript (no second actionable card)', () => {
        expect(chatList).not.toMatch(/<PermissionCard\b/);
        expect(chatList.match(/<PermissionPointer sessionId=\{sessionId\} \/>/g)).toHaveLength(2);
    });
    it('the transcript AskUserQuestion is a read-only receipt while the dock owns it', () => {
        const toolView = read('./ToolView.tsx');
        expect(toolView).toContain('const placement = useTranscriptQuestionPlacement(sessionId, livePendingId);');
        expect(toolView).toContain("if (placement !== 'inline' && !answered) {");
    });
});

describe('B-568 composer wiring', () => {
    const input = read('./AgentInput.tsx');
    it('a direct send records outcome sent; both queue paths record queued', () => {
        expect(input).toMatch(/await sendQueuedItem\(makeItem\(\), delivery\);\s+outcome = 'sent';/);
        // B-722: the server-queue branch reads its submit outcome, then records queued.
        expect(input).toMatch(/setQueued\(next\);\s+\}\s+outcome = 'queued';\s+return;/);
        expect(input).toMatch(/if \(queueOwnsItem\) \{\s+outcome = 'queued';/);
    });
    it('B-654: doSend declares outcome once, so the server-queue branch writes the outer one', () => {
        const outer = "let outcome: SendOutcome = 'failed';";
        const doSend = input.slice(input.indexOf(outer) + outer.length, input.indexOf('const interveneQueued = async'));
        expect(input.indexOf(outer)).toBeGreaterThan(0);
        expect(doSend).not.toMatch(/\b(?:let|const|var)\s+outcome\b/);
        expect(doSend).toContain('enqueued = await serverSubmit;');
    });
    it('the caret decision comes from focusAfterSend', () => {
        expect(input).toContain('const caret = focusAfterSend({ coarse: IS_COARSE_POINTER, hadFocus, softKeyboard, outcome });');
        expect(input).toContain("keyboardOpenAttr: taRef.current?.closest('[data-keyboard-open=\"true\"]') != null,");
        expect(input).toContain("else if (caret === 'blur') taRef.current?.blur();");
    });
    it('the placeholder switches while reconnecting', () => {
        expect(input).toContain("placeholder={networkOffline ? t('session.chat.sendOfflinePlaceholder') : reconnecting ? t('session.reconnectingPlaceholder') : t('session.inputPlaceholder')}");
    });
    it('the reconnect hint reads the existing socketStatus only (AGENTS 13)', () => {
        const hook = read('./useReconnectingHint.ts');
        expect(hook).toContain('const status = useSocketStatus();');
        expect(hook).toContain('const down = isReconnecting(status, everConnected);');
        expect(hook).not.toMatch(/addEventListener|visibilitychange|onfocus|io\.open/);
    });
    it('attachments are downscaled only for eligible images', () => {
        const att = read('./useAttachments.ts');
        expect(att).toContain('const target = shouldDownscaleImage(file.type) ? computeImageDownscale(width, height) : null;');
        expect(att).toContain('const smaller = await redrawImage(uri, file.type, file.size, target);');
        expect(att).toContain('if (target && !isAnimatedImage(new Uint8Array(await file.arrayBuffer()), file.type)) {');
    });
});
