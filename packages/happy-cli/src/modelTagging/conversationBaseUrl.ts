/**
 * B-980: the tagging forwarder's base URL for this wrapper's own conversation
 * query. Set once at session start when tagging is on; the Claude SDK query
 * options use it so only the conversation's requests (main turn, its
 * sub-agents) become the turn's `modelRequestIds`. Everything else inherits the
 * untracked URL from the process env.
 */
let conversationBaseUrl: string | null = null;

export function setConversationBaseUrl(url: string | null): void {
    conversationBaseUrl = url;
}

export function conversationEnvOverride(): Record<string, string> | undefined {
    return conversationBaseUrl ? { ANTHROPIC_BASE_URL: conversationBaseUrl } : undefined;
}
