/**
 * 跨包契约：web 剥的字面量必须与 CLI 拼进 prompt 的字面量逐字相同（B-355）。
 *
 * web 侧只能靠**文本形状**认出 `<attached_files>` 块——它不是 wire 字段，是 CLI 拼给模型
 * 看的 prompt 的一部分。CLI 改一次文案，web 就会静默地开始把那句英文说明当正文显示给
 * 用户，而单元测试全绿（两边各自的测试都只验自己那份常量）。所以这里直接读 CLI 源码。
 *
 * 手法与 `screens/public/publicContent.test.ts` 相同（B-350 记过：改 happy-cli 也要跑 web
 * 的源码断言测试）。已用 `node scripts/dev/mutation-check.mjs` 验过它真钉得住。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACHED_FILES_NOTE } from './attachedFiles';

const CLI_SOURCE = resolve(__dirname, '../../../../happy-cli/src/claude/utils/attachmentContent.ts');

describe('attached-files prompt contract', () => {
    const source = readFileSync(CLI_SOURCE, 'utf8');

    it('the CLI still emits the exact note the Web strips', () => {
        // The CLI writes it as two adjacent string literals; compare on the
        // concatenated value rather than the source formatting.
        const literals = [...source.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]);
        const joined = literals.join('');
        expect(joined, 'ATTACHED_FILES_NOTE drifted from happy-cli/attachmentContent.ts').toContain(ATTACHED_FILES_NOTE);
    });

    it('the append function actually USES that constant', () => {
        // Without this, deleting the call while keeping the constant defined
        // would leave the test above green and the Web stripping a note that is
        // no longer sent.
        const fn = source.slice(source.indexOf('export function appendStagedAttachmentsToPrompt'));
        expect(fn.slice(0, fn.indexOf('\n}'))).toContain('ATTACHMENT_PROMPT_NOTE');
    });

    it('the CLI still wraps the manifest in <attached_files>', () => {
        expect(source).toContain('<attached_files>');
        expect(source).toContain('</attached_files>');
    });

    it('the manifest is still one JSON object per line with the fields we read', () => {
        const fn = source.slice(source.indexOf('export function appendStagedAttachmentsToPrompt'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        for (const field of ['path', 'name', 'mimeType', 'size']) {
            expect(body, `manifest no longer carries ${field}`).toContain(`${field}: attachment.${field}`);
        }
        expect(body).toContain("join('\\n')");
    });
});
