/**
 * B-980: wire the request tagger into a Claude wrapper. The upstream is the
 * `ANTHROPIC_BASE_URL` the session would otherwise use (set by a bound API
 * account, or inherited from the daemon); when the instance config tags that
 * host, the wrapper env is pointed at the loopback forwarder so every Claude
 * child of this session (SDK, prewarm, /btw, title one-shots) goes through it.
 */
import { ensureLocalProxyBypass } from '@/claude/utils/proxyBypass';
import { loadInstanceClientConfig } from './instanceClientConfig';
import { shouldTagUpstream, startRequestTagger, type RequestTagger } from './requestTagger';
import { setConversationBaseUrl } from './conversationBaseUrl';

export async function startClaudeRequestTagging(opts: {
    env: NodeJS.ProcessEnv;
    sessionId: string;
    serverUrl: string;
    token: string;
    happyHome: string;
    /** A bound-but-unavailable account must keep failing closed; never tag (or reach) its gateway. */
    accountUsable: boolean;
    /** Global model channels are tagged regardless of `hosts`. */
    alwaysTag?: boolean;
    log?: (message: string) => void;
    fetch?: typeof fetch;
}): Promise<RequestTagger | null> {
    const upstream = opts.env.ANTHROPIC_BASE_URL?.trim();
    if (!opts.accountUsable || !upstream) return null;
    const config = await loadInstanceClientConfig({ serverUrl: opts.serverUrl, token: opts.token, happyHome: opts.happyHome, fetch: opts.fetch });
    const tagging = config.modelRequestTagging ?? null;
    if (!shouldTagUpstream(upstream, tagging, opts.alwaysTag)) return null;
    const tagger = await startRequestTagger({ upstream, sessionId: opts.sessionId, config: tagging!, onError: opts.log });
    opts.env.ANTHROPIC_BASE_URL = tagger.baseUrl;
    // An HTTP(S)_PROXY in the environment must not swallow loopback traffic.
    ensureLocalProxyBypass(opts.env);
    setConversationBaseUrl(tagger.conversationBaseUrl);
    opts.log?.(`tagging model requests via ${tagger.conversationBaseUrl}`);
    return {
        ...tagger,
        close: async () => {
            setConversationBaseUrl(null);
            await tagger.close();
        },
    };
}
