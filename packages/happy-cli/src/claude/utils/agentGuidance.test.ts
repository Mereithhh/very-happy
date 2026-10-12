import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    AGENT_GUIDANCE,
    GUIDANCE_MAX_CHARS,
    PREVIEW_TOOL_DESCRIPTION,
    PREVIEW_TOOL_NAME,
    REPORT_PROGRESS_TOOL_DESCRIPTION,
    REPORT_PROGRESS_TOOL_NAME,
} from './agentGuidance';
import { CLIPBOARD_TOOL_DESCRIPTION } from '@/clipboard/limits';
import { systemPrompt } from './systemPrompt';

const SRC = resolve(__dirname, '../../..', 'src');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

/** 三处 MCP 工具注册点（B-130 D2）。 */
const REGISTRATION_POINTS = [
    'claude/utils/startHappyServer.ts',  // http MCP —— 范围内
    'codex/happyMcpStdioBridge.ts',      // codex/gemini/acp 的 stdio bridge —— 范围内
    'commands/mcp.ts',                   // 裸终端的 stdio MCP —— 出范围，但共用常量以免漂移
    'claude/utils/reportProgressTool.ts', // B-556: report_progress 的共享注册（http MCP + bridge）
];

describe('AGENT_GUIDANCE', () => {
    it('不超字符上限——它每个会话无条件进 context', () => {
        expect(AGENT_GUIDANCE.length).toBeLessThanOrEqual(GUIDANCE_MAX_CHARS);
    });

    it('已拼进 systemPrompt（否则常量写了也没生效）', () => {
        expect(systemPrompt).toContain(AGENT_GUIDANCE);
    });

    it('提到三个工具，且用完整的 mcp__happy__ 前缀（claude 看到的就是带前缀的名字）', () => {
        expect(AGENT_GUIDANCE).toContain('mcp__happy__copy_to_clipboard');
        expect(AGENT_GUIDANCE).toContain(`mcp__happy__${PREVIEW_TOOL_NAME}`);
        expect(AGENT_GUIDANCE).toContain(`mcp__happy__${REPORT_PROGRESS_TOOL_NAME}`);
    });

    it('B-562: 告诉 agent 交付文件用 download: true，目录先打包', () => {
        expect(AGENT_GUIDANCE).toContain('download: true');
        expect(AGENT_GUIDANCE).toMatch(/Zip a directory first/);
    });

    it('写的是判断边界而不是硬规则（避免 claude 在不合适的场合硬调，spec 风险 4）', () => {
        expect(AGENT_GUIDANCE).toMatch(/Judgement|judgement/);
    });
});

describe('工具描述同源（B-130 D2）', () => {
    it('B-562: 三处注册点都声明了可选的 download 参数（stdio bridge 不声明会被 SDK 剥掉）', () => {
        // reportProgressTool.ts registers report_progress only — no open_preview there.
        for (const rel of REGISTRATION_POINTS.filter((r) => r !== 'claude/utils/reportProgressTool.ts')) {
            expect(read(rel), rel).toMatch(/download: z\.boolean\(\)\.optional\(\)\.describe\(PREVIEW_DOWNLOAD_PARAM_DESCRIPTION\)/);
        }
    });

    it('三处注册点都不内联描述字面量，只引用共享常量', () => {
        // 判据：拿每个描述的头 40 个字符当指纹，它只应出现在常量定义处，
        // 不应出现在任何注册点文件里。
        const fingerprints = [
            CLIPBOARD_TOOL_DESCRIPTION.slice(0, 40),
            PREVIEW_TOOL_DESCRIPTION.slice(0, 40),
            REPORT_PROGRESS_TOOL_DESCRIPTION.slice(0, 40),
        ];
        for (const rel of REGISTRATION_POINTS) {
            const src = read(rel);
            for (const fp of fingerprints) {
                expect(src.includes(fp), `${rel} 内联了描述字面量而不是引用常量：${fp}…`).toBe(false);
            }
        }
    });

    it('每个注册点引用的都是常量标识符', () => {
        const httpMcp = read('claude/utils/startHappyServer.ts');
        expect(httpMcp).toContain('PREVIEW_TOOL_DESCRIPTION');
        expect(read('claude/utils/reportProgressTool.ts')).toContain('description: REPORT_PROGRESS_TOOL_DESCRIPTION,');
        expect(httpMcp).toContain('registerReportProgressTool(mcp, async (args) => {');
        expect(httpMcp).toContain('CLIPBOARD_TOOL_DESCRIPTION');

        const bridge = read('codex/happyMcpStdioBridge.ts');
        expect(bridge).toContain('PREVIEW_TOOL_DESCRIPTION');
        expect(bridge).toContain('CLIPBOARD_TOOL_DESCRIPTION');

        const stdio = read('commands/mcp.ts');
        expect(stdio).toContain('CLIPBOARD_TOOL_DESCRIPTION');
    });
});
