import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { preparePiTeamsRuntime } from '@/teams/piRuntime';
import { registerMcpTools, registerTerminalTitleSuggest } from './mcp';
import { resolveMcpTerminalId } from './mcpToolSurface';

/** The generated extension needs only fetch; the CLI owns daemon credentials and path validation. */
export async function startPiTerminalTools(terminalId: string): Promise<{ url: string; stop: () => Promise<void> }> {
    const path = `/terminal-tools/${randomUUID()}`;
    const server = createServer(async (req, res) => {
        // The unguessable path is a runtime capability. Reject browser origins,
        // redirects and other paths before allowing access to daemon control.
        if (req.url !== path || req.headers.origin || req.method !== 'POST') {
            res.writeHead(403).end();
            return;
        }
        const mcp = new McpServer({ name: 'Very Happy Terminal Tools', version: '1.0.0' });
        registerMcpTools(mcp, 'clipboard', terminalId);
        registerTerminalTitleSuggest(mcp);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void transport.close(); void mcp.close(); });
        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } catch {
            if (!res.headersSent) res.writeHead(500).end();
            void mcp.close();
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
        stop: () => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        }),
    };
}

/** Explicit native pi launch; no ACP session, global Pi settings, or native permission overrides. */
export async function runPiTerminal(args: string[]): Promise<number> {
    const terminalId = resolveMcpTerminalId({ VH_TERMINAL_ID: process.env.VH_TERMINAL_ID });
    if (!terminalId) throw new Error('Run `very-happy pi --terminal` inside a Very Happy terminal (VH_TERMINAL_ID is required).');
    const runtime = await preparePiTeamsRuntime();
    const bridge = process.env.HAPPY_MCP_URL ? null : await startPiTerminalTools(terminalId);
    try {
        return await new Promise<number>((resolve, reject) => {
            const child = spawn(runtime.PI_ACP_PI_COMMAND, args, {
                stdio: 'inherit',
                env: { ...process.env, ...runtime, ...(bridge ? { HAPPY_TERMINAL_MCP_URL: bridge.url } : {}) },
                shell: process.platform === 'win32',
            });
            const interrupt = () => { child.kill('SIGINT'); };
            const terminate = () => { child.kill('SIGTERM'); };
            const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
            process.on('SIGINT', interrupt);
            process.on('SIGTERM', terminate);
            child.once('error', error => { cleanup(); reject(new Error(`Could not launch native pi: ${error.message}`)); });
            child.once('exit', (code, signal) => {
                cleanup();
                resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
            });
        });
    } finally {
        await bridge?.stop();
    }
}
