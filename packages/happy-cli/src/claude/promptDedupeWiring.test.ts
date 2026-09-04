/**
 * B-355 的接线回归守卫。
 *
 * 事故：remote 模式的 JSONL scanner 按**内容**去重「app 发来的 prompt」，但登记的是
 * `session.onUserMessage` 里那条**每条、未增广**的原文，而真正落进 Claude transcript 的是
 * **最终交给 SDK 的那个字符串**——队列会把同 mode 的多条 `join('\n')` 合批
 * （`utils/MessageQueue2.ts` `collectBatch`），远程 launcher 之后还会追加附件清单
 * （`appendStagedAttachmentsToPrompt`）。两处发散各自都会让去重落空，于是 web 上多出
 * 一条重复的 user 气泡（带附件时还带着一坨 `<attached_files>` XML）。
 *
 * 为什么是源码断言：这条 bug 坏的是**接线**（在哪里登记），不是某个纯函数的取值；纯函数
 * （`stripAttachmentManifest`）自己的测试在 `utils/attachmentContent.test.ts`。手法与
 * 仓库既有的 source-assertion 测试一致，并已用 `scripts/dev/mutation-check.mjs` 验过钉得住。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('prompt dedupe wiring', () => {
    const runClaude = read('./runClaude.ts');
    const launcher = read('./claudeRemoteLauncher.ts');
    const loop = read('./loop.ts');

    it('records the FINALISED prompt, via loop({ onPromptFinalized })', () => {
        expect(runClaude).toContain('onPromptFinalized: recordAppPrompt');
        expect(loop).toContain('onPromptFinalized');
        expect(loop).toContain('opts.onPromptFinalized');
    });

    it('does NOT record the per-message text in onUserMessage any more', () => {
        const handler = runClaude.slice(runClaude.indexOf('session.onUserMessage('));
        const body = handler.slice(0, handler.indexOf('\n    });'));
        expect(body, 'stamping here misses batching and attachment augmentation').not.toContain('recordAppPrompt(');
    });

    it('both sides of the comparison go through the same normalisation', () => {
        expect(runClaude).toContain('recentAppPrompts.push({ text: promptDedupeKey(text)');
        expect(runClaude).toContain('const key = promptDedupeKey(text)');
        // asymmetric trimming was the second half of the bug
        expect(runClaude).toContain('stripAttachmentManifest(text).trim()');
    });

    it('every path that hands a prompt to the SDK stamps it', () => {
        const nextMessage = launcher.slice(launcher.indexOf('nextMessage: async ()'));
        const scope = nextMessage.slice(0, nextMessage.indexOf('onSessionFound:'));
        // replayed parked message / with attachments / plain — named one by one
        // so mangling any single call site turns this red (a bare count does not:
        // `mutation-check` mangles the identifier inside the literal, not the line).
        expect(scope).toContain('onPromptFinalized?.(parked.message)');
        expect(scope).toContain('onPromptFinalized?.(withAttachments)');
        expect(scope).toContain('onPromptFinalized?.(msg.message)');
        // steering injects into the running turn and lands in the transcript too
        const steer = launcher.slice(launcher.indexOf('setSteerHandler'));
        expect(steer.slice(0, steer.indexOf('q.steer('))).toContain('onPromptFinalized?.');
    });
});
