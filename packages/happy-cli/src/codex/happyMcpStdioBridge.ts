/**
 * Happy MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing a single tool `change_title`.
 * On invocation it forwards the tool call to an existing Happy HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPPY_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { CLIPBOARD_TOOL_DESCRIPTION, CLIPBOARD_TOOL_NAME, CLIPBOARD_TOOL_TITLE } from '@/clipboard/limits';
import { PREVIEW_TOOL_DESCRIPTION, PREVIEW_TOOL_NAME, PREVIEW_TOOL_TITLE } from '@/claude/utils/agentGuidance';

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happy-mcp] Missing target URL. Set HAPPY_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'happy-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    httpClient = client;
    return client;
  }

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Happy MCP Bridge',
    version: '1.0.0',
  });

  // Register the single tool and forward to HTTP MCP
  server.registerTool(
    'change_title',
    {
      description: 'Change the title of the current chat session',
      title: 'Change Chat Title',
      inputSchema: {
        title: z.string().describe('The new title for the chat session'),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({ name: 'change_title', arguments: args });
        // Pass-through response from HTTP server
        return response as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to change chat title: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }
  );

  // B-131: forward open_preview too. codex/gemini/acp sessions are happy-managed
  // sessions like any other, so they get the same user-facing tool surface; the
  // path denylist and the actual push both live on the HTTP MCP side.
  server.registerTool(
    PREVIEW_TOOL_NAME,
    {
      description: PREVIEW_TOOL_DESCRIPTION,
      title: PREVIEW_TOOL_TITLE,
      inputSchema: {
        path: z.string().describe('Absolute path (or ~/…) of the file to show the user'),
        mode: z.enum(['file', 'diff']).optional(),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({ name: PREVIEW_TOOL_NAME, arguments: args });
        return response as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to open preview: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }
  );

  // Forward copy_to_clipboard to the same per-session HTTP MCP (the session
  // process pushes the text to the user's web clients over its own socket).
  server.registerTool(
    CLIPBOARD_TOOL_NAME,
    {
      description: CLIPBOARD_TOOL_DESCRIPTION,
      title: CLIPBOARD_TOOL_TITLE,
      inputSchema: {
        text: z.string().describe("The text to copy to the user's clipboard"),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({ name: CLIPBOARD_TOOL_NAME, arguments: args });
        return response as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to push to clipboard: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }
  );

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[happy-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});

