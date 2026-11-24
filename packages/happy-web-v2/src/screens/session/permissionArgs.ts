/** The key argument a permission ask shows (command, file path, or the JSON). Pure. */
/** B-969: DeepSeek Harness asks as its own `bash` tool (Claude-shaped `command` / `file_path` args). */
export function isCommandTool(tool: string): boolean {
    return tool === 'Bash' || tool === 'bash';
}

export function describeArgs(tool: string, args: any): string | null {
    if (!args || typeof args !== 'object') return null;
    if (isCommandTool(tool) && typeof args.command === 'string') return args.command;
    if (typeof args.file_path === 'string') return args.file_path;
    try {
        return JSON.stringify(args, null, 2);
    } catch {
        return null;
    }
}
