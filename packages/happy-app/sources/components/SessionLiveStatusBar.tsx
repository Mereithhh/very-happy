import * as React from 'react';
import { View, Text, Platform } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { useSession, useSessionRunningTool } from '@/sync/storage';
import { t } from '@/text';
import { layout } from '@/components/layout';

/**
 * Formats an elapsed second count compactly: "8s", "1m 12s", "3m".
 */
function formatElapsed(totalSeconds: number): string {
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

const stylesheet = StyleSheet.create((theme) => ({
    outer: {
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: layout.maxWidth,
        width: '100%',
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    label: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default(),
    },
    elapsed: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontVariant: ['tabular-nums'],
        ...Typography.default(),
    },
}));

type LiveStatusKind = 'thinking' | 'tool' | 'permission';

/**
 * Low-profile, always-mounted-while-active status bar that tells a remote user
 * what the agent is doing right now and for how long. Renders nothing when the
 * session is idle so it never competes with the input area.
 *
 * Precedence: pending permission > running tool > thinking. Permission is most
 * actionable; a concrete running tool is more informative than the generic
 * "thinking" flag, so it wins when both are present.
 */
export const SessionLiveStatusBar = React.memo(function SessionLiveStatusBar({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const session = useSession(sessionId);
    const runningTool = useSessionRunningTool(sessionId);

    const isOnline = session?.presence === 'online';
    const hasPermission = !!(session?.agentState?.requests && Object.keys(session.agentState.requests).length > 0);
    const isThinking = session?.thinking === true;

    // Decide what (if anything) to show and from which timestamp to count.
    let kind: LiveStatusKind | null = null;
    if (isOnline && hasPermission) {
        kind = 'permission';
    } else if (isOnline && runningTool) {
        kind = 'tool';
    } else if (isOnline && isThinking) {
        kind = 'thinking';
    }

    // Counting anchor: tool start for tools, thinkingStartedAt for thinking.
    // Permission has no elapsed counter (it's a steady call-to-action).
    const anchor = kind === 'tool'
        ? runningTool!.startedAt
        : kind === 'thinking'
            ? (session?.thinkingStartedAt ?? null)
            : null;
    const elapsedSeconds = useElapsedTime(anchor);

    if (!kind) {
        return null;
    }

    let label: string;
    let dotColor: string;
    let isPulsing = true;
    let elapsedText: string | null = null;

    if (kind === 'permission') {
        label = t('liveStatus.waitingPermission');
        dotColor = '#FF9500';
    } else if (kind === 'tool') {
        elapsedText = formatElapsed(elapsedSeconds);
        label = runningTool!.name;
        dotColor = '#007AFF';
    } else {
        elapsedText = formatElapsed(elapsedSeconds);
        label = t('liveStatus.thinking', { elapsed: elapsedText });
        elapsedText = null; // already folded into the label for thinking
        dotColor = '#007AFF';
    }

    return (
        <Animated.View
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(120)}
            style={styles.outer}
            pointerEvents="none"
        >
            <View style={styles.pill}>
                {kind === 'permission' ? (
                    <Ionicons name="alert-circle-outline" size={14} color={dotColor} />
                ) : (
                    <StatusDot color={dotColor} isPulsing={isPulsing} size={7} />
                )}
                <Text style={styles.label} numberOfLines={1}>
                    {label}
                </Text>
                {elapsedText && (
                    <Text style={styles.elapsed}>{elapsedText}</Text>
                )}
            </View>
        </Animated.View>
    );
});
