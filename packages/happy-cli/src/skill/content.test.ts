import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderReference, renderSkill, SKILL_AREAS, skillFiles } from './content';
import { VERY_HAPPY_DISCOVERY } from './discovery';
import { AUTO_HELP } from '@/commands/auto';
import { ISSUE_HELP } from '@/commands/issue';
import { TODO_HELP } from '@/commands/todo';
import { ACCOUNT_HELP } from '@/commands/account';
import { SESSIONS_HELP } from '@/commands/sessions';
import { TEAM_TOOL_NAMES } from '@/teams/tools';
import { AUTOMATION_TOOL_NAMES } from '@/automations/tools';
import { ISSUE_TOOL_NAMES } from '@/issues/tools';
import { PROJECT_TOOL_NAMES } from '@/projects/tools';
import { SESSION_PEER_TOOL_NAMES } from '@/sessions/peerTools';
import { OWNER_BOARD_TOOL_NAMES } from '@/attention/tools';
import { ASSISTANT_TOOL_NAMES } from '@/assistant/assistantTools';
import { CLIPBOARD_TOOL_NAME } from '@/clipboard/limits';
import { PREVIEW_TOOL_NAME, REPORT_PROGRESS_TOOL_NAME } from '@/claude/utils/agentGuidance';
import { REQUEST_HUMAN_TOOL_NAME } from '@/claude/utils/requestHuman';
import { TERMINAL_TITLE_TOOL_NAME } from '@/commands/mcpToolSurface';

const SRC = join(__dirname, '..');
const corpus = () => [renderSkill(), ...SKILL_AREAS.map((area) => renderReference(area.id)!)].join('\n');

/** Every `subcommand === 'x'` branch of the CLI entry point, i.e. the real dispatch table. */
export function topLevelCommands(mainSource: string): string[] {
    return [...new Set([...mainSource.matchAll(/subcommand === '([a-z][a-z-]*)'/g)].map((match) => match[1]))].sort();
}
/** Aliases that dispatch to the same handler; documenting either spelling covers both. */
const ALIASES: Record<string, string> = { accounts: 'account', issues: 'issue', session: 'sessions' };
/** Not a capability (prints "Bye!"). Anything else added to main.ts must be documented. */
const HIDDEN = new Set(['bye']);

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sourceFiles(path);
        return /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [path] : [];
    });
}

/** Agent-facing MCP tools: the exported name lists plus every literal registerTool('name', …). */
function agentToolNames(): string[] {
    const literal = sourceFiles(SRC).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((match) => match[1]));
    return [...new Set([
        ...TEAM_TOOL_NAMES, ...AUTOMATION_TOOL_NAMES, ...ISSUE_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...SESSION_PEER_TOOL_NAMES,
        ...OWNER_BOARD_TOOL_NAMES, ...ASSISTANT_TOOL_NAMES, CLIPBOARD_TOOL_NAME, PREVIEW_TOOL_NAME, REPORT_PROGRESS_TOOL_NAME,
        REQUEST_HUMAN_TOOL_NAME, TERMINAL_TITLE_TOOL_NAME, ...literal,
    ])].sort();
}

describe('B-917 very-happy skill coverage (CI guard against a stale skill)', () => {
    it('documents every top-level CLI command', () => {
        const commands = topLevelCommands(readFileSync(join(SRC, 'main.ts'), 'utf8'));
        expect(commands.length).toBeGreaterThan(20);
        expect(commands).toContain('skill');
        const text = corpus();
        const missing = commands.filter((command) => !HIDDEN.has(command))
            .filter((command) => ![command, ALIASES[command]].filter(Boolean).some((name) => text.includes(`very-happy ${name}`)));
        expect(missing).toEqual([]);
    });

    it('documents every MCP tool an agent can be given', () => {
        const tools = agentToolNames();
        expect(tools.length).toBeGreaterThan(40);
        const text = corpus();
        expect(tools.filter((tool) => !text.includes(`\`${tool}\``))).toEqual([]);
    });

    it('the extractors see a newly added command or tool (mutation check)', () => {
        expect(topLevelCommands("if (subcommand === 'frobnicate') {} else if (subcommand === 'auto')")).toEqual(['auto', 'frobnicate']);
        expect(corpus().includes('very-happy frobnicate')).toBe(false);
    });

    it('keeps the always-on line short, stable and pointing at both skills', () => {
        expect(VERY_HAPPY_DISCOVERY.length).toBeLessThanOrEqual(420);
        // No versions, dates or counts: a changing line would bust every session's prompt cache each release.
        expect(VERY_HAPPY_DISCOVERY).not.toMatch(/\d/);
        expect(VERY_HAPPY_DISCOVERY).toContain('`very-happy skill`');
        expect(VERY_HAPPY_DISCOVERY).toContain('`very-happy todo skill`');
        expect(VERY_HAPPY_DISCOVERY).toContain('restricted team workers must not bypass their scope');
    });

    it('stays within its context budgets', () => {
        expect(renderSkill().length).toBeLessThanOrEqual(7000); // ≈2K tokens
        for (const area of SKILL_AREAS) expect([area.id, renderReference(area.id)!.length <= 8000]).toEqual([area.id, true]);
        const description = /\ndescription: (.*)\n/.exec(renderSkill())![1];
        expect(description.length).toBeLessThanOrEqual(400);
    });

    it('maps every area exactly once and links todos to the official todo skill', () => {
        const ids = SKILL_AREAS.map((area) => area.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ['sessions', 'terminals', 'projects', 'teams', 'automations', 'issues-todos', 'accounts-models', 'machines-daemon', 'sharing', 'notifications-attention', 'panels', 'settings']) expect(ids).toContain(id);
        for (const id of ids) expect(renderSkill()).toContain(`| \`${id}\` |`);
        expect(renderReference('issues-todos')).toContain('`very-happy todo skill`');
        expect(renderReference('nope')).toBeNull();
        expect(Object.keys(skillFiles().files)).toEqual(ids.map((id) => `references/${id}.md`));
    });

    it('uses only flags that the command help documents', () => {
        const helps: Record<string, string> = { auto: AUTO_HELP, issue: ISSUE_HELP, todo: TODO_HELP, account: ACCOUNT_HELP, sessions: SESSIONS_HELP };
        const problems: string[] = [];
        for (const span of corpus().matchAll(/`very-happy ([a-z-]+)([^`]*)`/g)) {
            const help = helps[span[1]];
            if (!help) continue;
            for (const flag of span[2].match(/--[a-z][a-z-]*/g) ?? []) if (flag !== '--help' && !help.includes(flag)) problems.push(`${span[1]} ${flag}`);
        }
        expect(problems).toEqual([]);
    });

    it('the daily 09:00 project recipe is a valid auto create command', async () => {
        const { parseAutoArgs } = await import('@/commands/auto');
        const recipe = /`very-happy auto create ([^`]*--cron '0 9 \* \* \*'[^`]*)`/.exec(renderReference('automations')!)![1];
        const args = recipe.replace(/<[^>]*>/g, 'X').match(/'[^']*'|"[^"]*"|\S+/g)!.map((part) => part.replace(/^['"]|['"]$/g, ''));
        const command = parseAutoArgs(['create', ...args]);
        expect(command.flags['--cron']).toBe('0 9 * * *');
        expect(command.flags['--project']).toBe('current');
        expect(command.flags['--spawn-dir']).toBeDefined();
        expect(command.flags['--tz']).toBeDefined();
    });
});
