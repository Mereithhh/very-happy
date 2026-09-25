import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { projectPath } from './projectPath';
import { resolveMcpTerminalId } from './terminal/terminalToolContext';
import { TERMINAL_TITLE_SUGGEST_METHOD, TerminalTitleSuggestResultSchema } from './terminal/terminalTitleSuggest';

// Structural types keep this extension independent of the user's Pi version.
type PiContext = { cwd: string };
type PiApi = {
    on(event: 'session_start' | 'session_shutdown' | 'before_agent_start', handler: (event: unknown, ctx: PiContext) => Promise<void>): void;
    registerTool(tool: {
        name: string; label: string; description: string; parameters: unknown;
        execute(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    }): void;
    /** Pi ≥0.8x session naming (`/name`); optional so an older Pi still gets the tools. */
    getSessionName?(): string | undefined;
    setSessionName?(name: string): void;
};

/** Upper bound for the bridge round-trip: the one-shot itself gives up at 30s. */
const TITLE_SUGGEST_TIMEOUT_MS = 45_000;

/** Auto-discovered native Pi extension. Managed launchers own their own bridge. */
export default function piTerminalExtension(pi: PiApi): void {
    if (process.env.HAPPY_MCP_URL || process.env.HAPPY_TERMINAL_MCP_URL || !resolveMcpTerminalId(process.env)) return;
    let client: Client | undefined;
    let connecting: Promise<Client> | undefined;
    let stopped = false;
    let cwd = process.cwd();

    function connect(): Promise<Client> {
        if (stopped) return Promise.reject(new Error('Very Happy terminal tools have shut down'));
        if (connecting) return connecting;
        if (client) return Promise.resolve(client);
        const current = new Client({ name: 'very-happy-pi-terminal', version: '1' });
        client = current;
        current.onclose = () => { if (client === current) client = undefined; };
        const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        // A terminal belongs to the daemon that created it, even if the shell
        // also carries a different HAPPY_HOME_DIR. Never mutate Pi's own env.
        if (env.VH_HAPPY_HOME_DIR) env.HAPPY_HOME_DIR = env.VH_HAPPY_HOME_DIR;
        const transport = new StdioClientTransport({
            // Pi may itself be a Bun/SEA executable. Use the CLI's Node runtime
            // from PATH, just like the installed very-happy shebang.
            command: 'node',
            args: ['--no-warnings', '--no-deprecation', resolve(projectPath(), 'dist/index.mjs'), 'mcp', '--terminal-tools'],
            env, cwd, stderr: 'pipe',
        });
        // Drain startup diagnostics without forwarding daemon details into Pi.
        transport.stderr?.on('data', () => {});
        connecting = current.connect(transport, { timeout: 10_000 }).then(async () => {
            if (stopped) {
                await current.close();
                throw new Error('Very Happy terminal tools have shut down');
            }
            return current;
        }).catch(async (error) => {
            if (client === current) client = undefined;
            await current.close();
            throw error;
        }).finally(() => { connecting = undefined; });
        return connecting;
    }

    // B-500 auto-title: armed per pi session (session_start fires for startup,
    // /new, /resume, fork and /reload) when the session has no name yet; the
    // first prompt of that session asks the bridge for a title and names the
    // pi session with it. Pi then rewrites its OSC title as
    // `π - <name> - <cwd>` and the daemon follows it into the tab title
    // (deriveAutoTitle) — unless the user renamed the tab, which pins it.
    // Fire-and-forget: before_agent_start must never delay the agent loop.
    // `generation` drops a suggestion that lands after /new or /resume.
    let titleArmed = false;
    let generation = 0;

    pi.on('session_start', async (_event, ctx) => {
        cwd = ctx.cwd;
        generation += 1;
        titleArmed = !!pi.setSessionName && !pi.getSessionName?.();
        const current = await connect();
        const available = await current.listTools({}, { timeout: 10_000 });
        if (stopped) return;
        for (const tool of available.tools) {
            pi.registerTool({
                name: tool.name, label: tool.title || tool.name,
                description: tool.description || tool.name, parameters: tool.inputSchema,
                async execute(_id, args, signal) {
                    const active = await connect();
                    const result = await active.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: 30_000 });
                    // Pi marks failures only when execute throws; details.isError
                    // alone would leave the transcript/tool UI showing success.
                    if (result.isError) {
                        const content = Array.isArray(result.content) ? result.content : [];
                        throw new Error(content.filter(block => block.type === 'text').map(block => block.text).join('\n') || 'Very Happy tool failed');
                    }
                    return { content: result.content, details: { isError: !!result.isError } };
                },
            });
        }
    });
    pi.on('before_agent_start', async (event) => {
        if (!titleArmed) return;
        const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) return;
        titleArmed = false;
        const expected = generation;
        void (async () => {
            const active = await connect();
            const result = await active.request(
                { method: TERMINAL_TITLE_SUGGEST_METHOD, params: { prompt } },
                TerminalTitleSuggestResultSchema,
                { timeout: TITLE_SUGGEST_TIMEOUT_MS },
            );
            // Never overwrite a name the user (/name) or the model set meanwhile.
            if (result.title && expected === generation && !stopped && !pi.getSessionName?.()) pi.setSessionName!(result.title);
        })().catch(() => { /* keep the current title; the bridge already logged */ });
    });
    pi.on('session_shutdown', async () => {
        stopped = true;
        await connecting?.catch(() => {});
        await client?.close();
        client = undefined;
    });
}
