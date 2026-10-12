import { resolveAgainstCwd } from './toolFilePath';
import type { ToolHistoryEntry } from '@/sync/toolHistory';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { normalizePreviewPath } from '@/sync/filePreview';

export interface PreviewToolCall {
    /** As the agent wrote it (absolute, `~/…` or cwd-relative). */
    path: string;
    /** B-562: `open_preview(download: true)` — the agent is delivering the file. */
    download: boolean;
}

/**
 * An `open_preview` call in ANY runner's name shape (B-499 identity: Claude
 * `mcp__happy__…`, terminal `mcp__very-happy__…`, Gemini `happy__…`, Codex
 * `McpTool`, pi `piTool`, bare). Pure web: works for transcripts written by
 * CLIs that predate the `download` flag.
 */
export function previewToolCall(tool: ToolCall): PreviewToolCall | null {
    const input = previewToolInput(tool);
    const path = input ? normalizePreviewPath(input.path) : null;
    return path ? { path, download: input!.download === true } : null;
}

/** Same shape rules as `resolveBuiltinTool` (components/tools/builtinTools.ts),
 *  kept local so this module stays free of the i18n/text runtime. */
function previewToolInput(tool: ToolCall): Record<string, any> | null {
    const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, any> : {};
    const own = (server: unknown) => typeof server === 'string' && /happy/i.test(server);
    if (input.piTool === 'open_preview') return objectOr(input.rawInput);
    if (tool.name === 'McpTool') return input.tool === 'open_preview' && own(input.server) ? objectOr(input.arguments) : null;
    if (typeof tool.name !== 'string') return null;
    if (tool.name === 'open_preview') return input;
    const bare = tool.name.startsWith('mcp__') ? tool.name.slice('mcp__'.length) : tool.name;
    const cut = bare.lastIndexOf('__');
    return cut > 0 && bare.slice(cut + 2) === 'open_preview' && own(bare.slice(0, cut)) ? input : null;
}

function objectOr(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

/**
 * B-562: tool cards cannot rely on the call having FAILED when the CLI refused
 * it — Claude's MCP errors reach the transcript as `state: 'completed'` with no
 * result (verified in a real session). So the one-click Open/Download actions
 * mirror the CLI's credential-path gate (`happy-cli/src/claude/utils/previewPath.ts`)
 * and are withheld for those paths. Without the remote home directory this
 * matches the directories anywhere in the path — stricter, never looser.
 */
const CREDENTIAL_DIRS = ['.secrets', '.ssh', '.gnupg', '.aws', '.kube', '.config/rbw'];
const CREDENTIAL_FILES = ['.claude.json', '.claude/.credentials.json', '.netrc', '.pgpass'];
const CREDENTIAL_BASENAMES = [/^\.env$/i, /^\.env\./i, /\.env$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/i, /^\.htpasswd$/i];
export function isCredentialLikePath(path: string): boolean {
    const p = `/${path.replace(/\\/g, '/').replace(/^~\/?/, '')}`.replace(/\/+/g, '/');
    if (CREDENTIAL_DIRS.some(dir => p.includes(`/${dir}/`) || p.endsWith(`/${dir}`))) return true;
    if (CREDENTIAL_FILES.some(file => p.endsWith(`/${file}`))) return true;
    if (p.endsWith('/.git/config')) return true;
    const base = p.split('/').pop() ?? '';
    return CREDENTIAL_BASENAMES.some(re => re.test(base));
}

export function previewToolPath(tool: ToolCall): string | null {
    return previewToolCall(tool)?.path ?? null;
}

export function sessionPreviewPaths(messages: Message[]): string[] {
    const paths = new Set<string>();
    function visit(items: Message[]) {
        for (const message of items) {
            if (message.kind !== 'tool-call') continue;
            const path = previewToolPath(message.tool);
            if (path) paths.add(path);
            visit(message.children);
        }
    }
    visit(messages);
    return [...paths];
}

export function legacyPreviewHistory(paths: string[], cwd?: string): ToolHistoryEntry[] {
    return [...new Set(paths.map(path => resolveAgainstCwd(path, cwd)))].map(path => ({
        id:`legacy-preview:${path}`,kind:'preview',createdAt:0,text:path,
    }));
}
