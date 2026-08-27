import type { CommandItem } from '@/sync/suggestionCommands';

export function slashQuery(text: string): string | null {
    const match = text.match(/^\/([^\s/]*)$/);
    return match ? match[1].toLowerCase() : null;
}

export function filterSlashSuggestions(items: readonly CommandItem[], text: string, limit = 8): CommandItem[] {
    const query = slashQuery(text);
    if (query === null) return [];
    const ranked = items.flatMap((item, index) => {
        const command = item.command.toLowerCase();
        const match = command === query ? 0 : command.startsWith(query) ? 1 : command.includes(query) ? 2 : -1;
        return match < 0 ? [] : [{ item, match, index }];
    });
    return ranked
        .sort((a, b) => a.match - b.match || a.index - b.index)
        .slice(0, limit)
        .map(({ item }) => item);
}

export function slashCommandText(item: CommandItem): string {
    return `/${item.command}`;
}
