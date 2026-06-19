/**
 * AttentionBar — the "needs attention" queue.
 *
 * Surfaces every online session that is currently blocked on a pending
 * permission request, at the top of the sidebar, so the user can jump straight
 * to whatever is waiting on them instead of scanning the whole session list.
 * Renders nothing when nothing is waiting.
 */

import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useAttentionSessions } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { Typography } from '@/constants/Typography';

const ACCENT = '#FF9500';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: ACCENT,
        backgroundColor: theme.dark ? 'rgba(255,149,0,0.12)' : 'rgba(255,149,0,0.08)',
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
    },
    headerText: {
        fontSize: 12,
        color: ACCENT,
        ...Typography.default('semiBold'),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    rowText: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    countBadge: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: ACCENT,
    },
    countText: {
        fontSize: 11,
        color: '#fff',
        ...Typography.default('semiBold'),
    },
}));

export const AttentionBar = React.memo(() => {
    const styles = stylesheet;
    const router = useRouter();
    const sessions = useAttentionSessions();

    if (sessions.length === 0) return null;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Ionicons name="alert-circle" size={14} color={ACCENT} />
                <Text style={styles.headerText}>
                    {sessions.length} waiting on you
                </Text>
            </View>
            {sessions.map((s) => {
                const count = s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0;
                return (
                    <Pressable
                        key={s.id}
                        onPress={() => router.navigate(`/session/${s.id}`)}
                        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    >
                        <Ionicons name="shield-checkmark-outline" size={16} color={ACCENT} />
                        <Text style={styles.rowText} numberOfLines={1}>
                            {getSessionName(s)}
                        </Text>
                        {count > 1 && (
                            <View style={styles.countBadge}>
                                <Text style={styles.countText}>{count}</Text>
                            </View>
                        )}
                        <Ionicons name="chevron-forward" size={14} color={ACCENT} />
                    </Pressable>
                );
            })}
        </View>
    );
});
