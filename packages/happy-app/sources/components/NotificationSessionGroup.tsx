import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { ItemGroup } from './ItemGroup';
import { Item } from './Item';
import { markReadUpTo } from '@/sync/notificationReadState';
import type { NotificationSessionGroup as Group, NotificationEntry } from '@/sync/useNotificationFeed';
import type { NotifType } from '@/sync/feedTypes';

const stylesheet = StyleSheet.create((theme) => ({
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        minWidth: 0,
    },
    unreadDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.textLink,
        marginRight: 8,
    },
    sessionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        textTransform: 'uppercase',
        flexShrink: 1,
    },
    countBadge: {
        marginLeft: 8,
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 5,
        backgroundColor: theme.colors.textLink,
        alignItems: 'center',
        justifyContent: 'center',
    },
    countBadgeText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        color: theme.colors.button.primary.tint,
    },
}));

function iconFor(type: NotifType, theme: any): { name: keyof typeof Ionicons.glyphMap; color: string } {
    switch (type) {
        case 'permission_request':
            return { name: 'shield-checkmark-outline', color: theme.colors.permission?.bypass ?? theme.colors.status.connecting };
        case 'input_needed':
            return { name: 'chatbubble-ellipses-outline', color: theme.colors.status.connecting };
        case 'reply_done':
            return { name: 'checkmark-circle-outline', color: theme.colors.success };
        case 'error':
            return { name: 'alert-circle-outline', color: theme.colors.status.error };
        default:
            return { name: 'notifications-outline', color: theme.colors.textSecondary };
    }
}

function timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return t('time.justNow');
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    return t('sessionHistory.daysAgo', { count: days });
}

const NotificationRow = React.memo(({ entry, onPress }: { entry: NotificationEntry; onPress: () => void }) => {
    const { theme } = useUnistyles();
    const icon = iconFor(entry.notifType, theme);
    return (
        <Item
            title={entry.title}
            subtitle={entry.snippet || undefined}
            subtitleLines={2}
            detail={timeAgo(entry.createdAt)}
            leftElement={
                <View style={{ width: 32, alignItems: 'center', justifyContent: 'center', flexDirection: 'row' }}>
                    {entry.unread && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.textLink, marginRight: 4 }} />}
                    <Ionicons name={icon.name} size={22} color={icon.color} />
                </View>
            }
            onPress={onPress}
            showChevron
            titleStyle={entry.unread ? { ...Typography.default('semiBold') } : undefined}
        />
    );
});

export const NotificationSessionGroupView = React.memo(({ group }: { group: Group }) => {
    const styles = stylesheet;
    const router = useRouter();
    const { theme } = useUnistyles();
    const session = useSession(group.sessionId);

    const sessionName = session ? getSessionName(session) : t('notifications.unknownSession');

    const goToSession = React.useCallback(() => {
        // Mark the whole group read on navigation.
        const maxCounter = group.entries.reduce((m, e) => Math.max(m, e.counter), 0);
        markReadUpTo(maxCounter);
        router.push(`/session/${group.sessionId}`);
    }, [group, router]);

    const title = (
        <Pressable onPress={goToSession} style={styles.titleRow} hitSlop={6}>
            {group.unreadCount > 0 && <View style={styles.unreadDot} />}
            <Text style={styles.sessionTitle} numberOfLines={1}>{sessionName}</Text>
            {group.unreadCount > 0 && (
                <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>{group.unreadCount}</Text>
                </View>
            )}
        </Pressable>
    );

    return (
        <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)} layout={LinearTransition.springify().damping(20)}>
            <ItemGroup title={title}>
                {group.entries.map((entry) => (
                    <NotificationRow key={entry.id} entry={entry} onPress={goToSession} />
                ))}
            </ItemGroup>
        </Animated.View>
    );
});
