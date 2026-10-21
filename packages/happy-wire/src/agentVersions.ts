import { z } from 'zod';

export const AgentVersionsSchema = z.object({
    checkedAt: z.number(),
    daemonPid: z.number(),
    agents: z.array(z.object({
        id: z.string(),
        installed: z.string().nullable(),
        latest: z.string().nullable(),
        status: z.string(),
    })),
});
export type AgentVersions = z.infer<typeof AgentVersionsSchema>;

/** IDs and URLs are ours, never commands or links supplied by a registry response. */
export const AGENT_VERSION_SOURCES = [
    { id:'claude', label:'Claude Code', command:'claude', package:'@anthropic-ai/claude-code', docs:'https://code.claude.com/docs/en/setup' },
    { id:'codex', label:'Codex', command:'codex', package:'@openai/codex', docs:'https://github.com/openai/codex#installation-and-usage' },
    // B-719: @mariozechner/pi-coding-agent is deprecated at 0.73.1 ("use @earendil-works/pi-coding-agent"),
    // so comparing against it reported every newer pi as current.
    { id:'pi', label:'Pi', command:'pi', package:'@earendil-works/pi-coding-agent', docs:'https://github.com/earendil-works/pi' },
    { id:'gemini', label:'Gemini CLI', command:'gemini', package:'@google/gemini-cli', docs:'https://github.com/google-gemini/gemini-cli#installation' },
    { id:'opencode', label:'OpenCode', command:'opencode', package:'opencode-ai', docs:'https://opencode.ai/docs/' },
    { id:'openclaw', label:'OpenClaw', command:'openclaw', package:'openclaw', docs:'https://docs.openclaw.ai/install/updating' },
    { id:'claude-sdk', label:'Claude Agent SDK', command:null, package:'@anthropic-ai/claude-agent-sdk', docs:'https://github.com/anthropics/claude-agent-sdk-typescript' },
] as const;
