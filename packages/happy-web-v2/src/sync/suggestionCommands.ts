/**
 * Suggestion commands functionality for slash commands
 * Reads commands directly from session metadata storage
 */

import Fuse from 'fuse.js';
import { storage } from './storage';
import { buildCommandItems, type CommandItem } from './suggestionCommandItems';
export { buildCommandItems, IGNORED_COMMANDS } from './suggestionCommandItems';
export type { CommandItem } from './suggestionCommandItems';

interface SearchOptions {
    limit?: number;
    threshold?: number;
}

function getCommandsFromSession(sessionId: string): CommandItem[] {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    if (!session || !session.metadata) {
        return buildCommandItems();
    }

    return buildCommandItems(session.metadata.slashCommands, session.metadata.skills);
}

// Main export: search commands with fuzzy matching
export async function searchCommands(
    sessionId: string,
    query: string,
    options: SearchOptions = {}
): Promise<CommandItem[]> {
    const { limit = 10, threshold = 0.3 } = options;
    
    // Get commands from session metadata (no caching)
    const commands = getCommandsFromSession(sessionId);
    
    // If query is empty, return all commands
    if (!query || query.trim().length === 0) {
        return commands.slice(0, limit);
    }
    
    // Setup Fuse for fuzzy search
    const fuseOptions = {
        keys: [
            { name: 'command', weight: 0.7 },
            { name: 'description', weight: 0.3 }
        ],
        threshold,
        includeScore: true,
        shouldSort: true,
        minMatchCharLength: 1,
        ignoreLocation: true,
        useExtendedSearch: true
    };
    
    const fuse = new Fuse(commands, fuseOptions);
    const results = fuse.search(query, { limit });
    
    return results.map(result => result.item);
}

// Get all available commands for a session
export function getAllCommands(sessionId: string): CommandItem[] {
    return getCommandsFromSession(sessionId);
}
