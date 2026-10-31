/**
 * B-645 regression: project tools and injection reach every runner that has a
 * happy MCP server, and project text never enters the system layer.
 *  - Tools: registered in-process (Claude / ACP / Gemini via startHappyServer,
 *    advertised in toolNames → SDK allowedTools), forwarded by name by the
 *    Codex stdio bridge, discovered by pi over HAPPY_MCP_URL tools/list.
 *  - Capability `project-v1`: only runners that actually inject advertise it
 *    (Claude, Codex, ACP/pi, Gemini). OpenClaw has no happy MCP and no
 *    injection → no capability → the Web marks it 「未注入」.
 *  - Claude: the prefix rides on the dequeued user message inside the launcher;
 *    the system prompt only gains the constant PROJECT_HINT, so joining,
 *    leaving or an instructions change cannot alter claudeModeHash or the
 *    prewarm key (both computed from EnhancedMode, which the injector never sees).
 * Source assertions verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PI_TEAMS_EXTENSION } from '@/teams/resources';
import { claudeModeHash } from '@/claude/claudeModeHash';
import { systemPrompt } from '@/claude/utils/systemPrompt';
import { AGENT_GUIDANCE } from '@/claude/utils/agentGuidance';
import { PROJECT_HINT } from './prompt';
import { createProjectInjector } from './injector';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');

describe('project tool surface across runners', () => {
    it('managed Claude/ACP/Gemini: registered in-process with the session identity and advertised in toolNames', () => {
        const source = read('../claude/utils/startHappyServer.ts');
        expect(source).toContain('if (client) registerProjectTools(mcp, createProjectToolExecutor(() => client.sessionId));');
        expect(source).toContain('...PROJECT_TOOL_NAMES,');
    });
    it('Codex: forwarded by the stdio bridge without new literal registrations', () => {
        const source = read('../codex/happyMcpStdioBridge.ts');
        expect(source).toContain('registerProjectTools(server, async (name, args) => {');
        expect(source.match(/registerTool\(/g)).toHaveLength(3);
    });
    it('pi: picked up by dynamic tools/list over HAPPY_MCP_URL', () => {
        expect(PI_TEAMS_EXTENSION).toContain("await rpc('tools/list', {})");
    });
});

describe('project-v1 capability and injection points', () => {
    it('each injecting runner advertises project-v1 and decorates the prompt it sends', () => {
        const claude = read('../claude/runClaude.ts');
        expect(claude).toContain('HIBERNATION_CAPABILITY, AUTO_RESTART_CAPABILITY, PROJECT_SESSION_CAPABILITY, RUN_INTENT_CAPABILITY, CLAUDE_CONFIG_MODEL_CAPABILITY],');
        const launcher = read('../claude/claudeRemoteLauncher.ts');
        expect(launcher).toContain('project: session.projectInjector,');
        expect(read('../claude/finalizeRemotePrompt.ts')).toContain('return deps.project.decorate(text);');
        expect(launcher).toContain('onPromptFinalized?.(out);');
        expect(launcher).toContain('const finalized = await finalize(msg.message);');
        const codex = read('../codex/runCodex.ts');
        expect(codex).toContain('CODEX_STEER_CAPABILITY, PROJECT_SESSION_CAPABILITY, CODEX_COMPACT_CAPABILITY, RUN_INTENT_CAPABILITY],');
        expect(codex).toContain('message: await projectInjector.decorate(message.message),');
        const acp = read('../agent/acp/runAcp.ts');
        expect(acp).toContain('capabilities: [PROMPT_QUEUE_CAPABILITY, PROJECT_SESSION_CAPABILITY, ...(opts.agentName === ');
        // B-727: decoration goes through buildAcpPrompt (slash commands stay verbatim; acpSlashCommand.test.ts).
        expect(acp).toContain('const { prompt, slashCommand } = await buildAcpPrompt(batch.message, {');
        expect(acp).toContain('decorate: (m) => projectInjector.decorate(m),');
        expect(acp).toContain('projectInjector.reset();');
        const gemini = read('../gemini/runGemini.ts');
        expect(gemini).toContain('capabilities: [PROJECT_SESSION_CAPABILITY],');
        expect(gemini).toContain('let promptToSend = await projectInjector.decorate(message.message);');
    });
    it('OpenClaw does not claim project-v1 (no happy MCP, no injection → 未注入)', () => {
        const openclaw = read('../openclaw/runOpenClaw.ts');
        expect(openclaw).not.toContain('PROJECT_SESSION_CAPABILITY');
        expect(openclaw).not.toContain('projectInjector');
    });
    it('steering into a running turn is never decorated (mid-turn input is not a new turn)', () => {
        const launcher = read('../claude/claudeRemoteLauncher.ts');
        const steer = launcher.slice(launcher.indexOf('q.steer(') - 600, launcher.indexOf('q.steer('));
        expect(steer).not.toContain('projectInjector');
    });
});

describe('project text never enters the system layer', () => {
    it('the Claude system prompt gains only the constant hint, outside the AGENT_GUIDANCE budget', () => {
        expect(systemPrompt).toContain(PROJECT_HINT);
        expect(AGENT_GUIDANCE).not.toContain(PROJECT_HINT);
        expect(systemPrompt.match(/Very Happy project/g)).toHaveLength(1);
    });
    it('join / leave / instructions change leave claudeModeHash unchanged', async () => {
        const mode = { permissionMode: 'default', appendSystemPrompt: systemPrompt, allowedTools: ['mcp__happy__project_context'] } as any;
        const before = claudeModeHash(mode);
        let instructions = 'v1';
        let member = true;
        const client = {
            isDisabled: () => false,
            context: async () => ({ project: member ? { id: 'p', name: 'n', goal: null, instructions, instructionsVersion: instructions.length } : null, via: 'explicit', team: null, decisions: [], log: [], sessions: [], unread: [], asOf: 1, previousReadAt: 0 }),
            digest: async () => ({ projectId: member ? 'p' : null, name: member ? 'n' : null, instructions: { version: 9, summary: null }, decisions: [], revoked: [], messages: [], asOf: 2 }),
            presence: async () => ({ memberships: {} }), delivered: async () => ({ delivered: 0 }),
        } as any;
        const inj = createProjectInjector({ client, sessionId: () => 's', agent: 'claude' });
        await inj.decorate('a');
        instructions = 'v2 changed';
        await inj.decorate('b');
        member = false;
        await inj.decorate('c');
        expect(claudeModeHash(mode)).toBe(before);
        expect(mode.appendSystemPrompt).toBe(systemPrompt);
    });
});
