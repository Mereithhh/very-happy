import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * Token usage snapshot, mirrors the shape of `Session.latestUsage`
 * (see storageTypes.ts). Cache fields are optional and only rendered
 * when present / non-zero.
 */
export interface MessageMetaUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreation?: number;
    cacheRead?: number;
    contextSize?: number;
    timestamp?: number;
}

export interface MessageMetaRowProps {
    /** Model name used for this assistant turn (e.g. "opus", "claude-...""). */
    model?: string | null;
    /** Token usage snapshot. */
    usage?: MessageMetaUsage | null;
    /**
     * Reserved for #6 (cost wiring). When provided, renders the USD cost.
     * Not passed today.
     */
    costUsd?: number;
    /**
     * Reserved for #6. Total wall-clock duration of the turn in ms.
     * Not passed today.
     */
    totalDurationMs?: number;
    /**
     * Reserved for #6. Number of agent turns/round-trips.
     * Not passed today.
     */
    numTurns?: number;
}

/**
 * Compact, secondary-color metadata line shown beneath the latest assistant
 * answer: model name + token usage, plus optional cost / duration / turns.
 *
 * Designed to wrap gracefully on narrow (mobile web) screens and to disappear
 * entirely when there's nothing meaningful to show.
 */
function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
    return String(n);
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

export const MessageMetaRow = React.memo<MessageMetaRowProps>((props) => {
    const { model, usage, costUsd, totalDurationMs, numTurns } = props;

    const parts: string[] = [];

    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
        const tokenBits: string[] = [];
        tokenBits.push(`↑${formatTokens(usage.inputTokens)}`);
        tokenBits.push(`↓${formatTokens(usage.outputTokens)}`);
        const cache = (usage.cacheRead || 0) + (usage.cacheCreation || 0);
        if (cache > 0) {
            tokenBits.push(`⚡${formatTokens(cache)}`);
        }
        parts.push(`${tokenBits.join(' ')} tokens`);
    }

    if (typeof costUsd === 'number' && costUsd > 0) {
        parts.push(`$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`);
    }
    if (typeof totalDurationMs === 'number' && totalDurationMs > 0) {
        parts.push(formatDuration(totalDurationMs));
    }
    if (typeof numTurns === 'number' && numTurns > 0) {
        parts.push(`${numTurns} ${numTurns === 1 ? 'turn' : 'turns'}`);
    }

    // Nothing meaningful to show
    if (!model && parts.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            {model ? (
                <Text style={styles.model} numberOfLines={1} ellipsizeMode="tail">
                    {model}
                </Text>
            ) : null}
            {model && parts.length > 0 ? <Text style={styles.dot}>·</Text> : null}
            {parts.map((p, i) => (
                <React.Fragment key={i}>
                    {i > 0 ? <Text style={styles.dot}>·</Text> : null}
                    <Text style={styles.meta} numberOfLines={1}>
                        {p}
                    </Text>
                </React.Fragment>
            ))}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 6,
        rowGap: 2,
        marginTop: 2,
        marginBottom: 4,
    },
    model: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        fontWeight: '500',
        flexShrink: 1,
        maxWidth: '100%',
    },
    meta: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        flexShrink: 1,
    },
    dot: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        opacity: 0.5,
    },
}));
