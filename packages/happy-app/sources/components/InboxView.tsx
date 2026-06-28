import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage, useFeedItems, useFeedLoaded, useRealtimeStatus } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { t } from '@/text';
import { ItemGroup } from '@/components/ItemGroup';
import { UpdateBanner } from './UpdateBanner';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';
import { layout } from '@/components/layout';
import { useIsTablet } from '@/utils/responsive';
import { Header } from './navigation/Header';
import { Ionicons } from '@expo/vector-icons';
import { FeedItemCard } from './FeedItemCard';
import { CyberMark } from './CyberMark';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useNotificationFeed, type NotificationSessionGroup } from '@/sync/useNotificationFeed';
import { NotificationSessionGroupView } from './NotificationSessionGroup';
import { StatusDot, type StatusDotKind } from './StatusDot';
import type { SessionState } from '@/utils/sessionUtils';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyIcon: {
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 20,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyDescription: {
        fontSize: 16,
        ...Typography.default(),
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
    },
    laneHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 28,
        paddingBottom: 4,
        paddingHorizontal: 32,
    },
    laneHeaderDot: {
        marginRight: 8,
    },
    laneHeaderText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        textTransform: 'uppercase',
        letterSpacing: 0.2,
    },
    laneHeaderTextWarning: {
        color: theme.colors.warning,
    },
}));

interface InboxViewProps {
}

// Derived per-session attention signal for a notification group. Mirrors the
// session-state logic in storage.buildSessionRowData (presence → permission →
// thinking → waiting) plus the memory-only unread flag, but selected only for
// the sessions that currently have notifications so heartbeat churn on unrelated
// sessions doesn't re-render the inbox.
interface SessionSignal {
    state: SessionState;
    hasUnread: boolean;
}

function useSessionSignals(sessionIds: string[]): Record<string, SessionSignal> {
    // Stable key so the selector only re-subscribes when the set of relevant
    // sessions changes, not on every render.
    const key = sessionIds.join(',');
    return storage(
        useShallow((s) => {
            const out: Record<string, SessionSignal> = {};
            for (const id of key ? key.split(',') : []) {
                const session = s.sessions[id];
                let state: SessionState;
                if (!session) {
                    state = 'disconnected';
                } else {
                    const isOnline = session.presence === 'online';
                    const hasPermissions = !!(
                        session.agentState?.requests &&
                        Object.keys(session.agentState.requests).length > 0
                    );
                    if (!isOnline) state = 'disconnected';
                    else if (hasPermissions) state = 'permission_required';
                    else if (session.thinking) state = 'thinking';
                    else state = 'waiting';
                }
                out[id] = { state, hasUnread: s.unreadSessionIds.has(id) };
            }
            return out;
        })
    );
}

// Attention-triage lanes: each group is routed to exactly one lane by "why it
// needs you", then lanes render newest-first. Approval is most urgent and pins
// to the top; thinking is in-flight; unread (completed / new results) is to
// review; everything else falls to the bottom alongside non-notification feed.
type LaneKey = 'needsApproval' | 'inProgress' | 'toReview' | 'other';

interface LaneConfig {
    title: string;
    kind: StatusDotKind;
    warning?: boolean;
}

function LaneHeader({ config }: { config: LaneConfig }) {
    return (
        <View style={styles.laneHeader}>
            <StatusDot
                kind={config.kind}
                size={8}
                style={styles.laneHeaderDot}
                accessibilityLabel={config.title}
            />
            <Text style={[styles.laneHeaderText, config.warning && styles.laneHeaderTextWarning]}>
                {config.title}
            </Text>
        </View>
    );
}

export const InboxView = React.memo(({}: InboxViewProps) => {
    const feedItems = useFeedItems();
    const feedLoaded = useFeedLoaded();
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const realtimeStatus = useRealtimeStatus();
    const notifications = useNotificationFeed();

    const sessionIds = React.useMemo(
        () => notifications.groups.map((g) => g.sessionId),
        [notifications.groups]
    );
    const signals = useSessionSignals(sessionIds);

    // Session notifications render in their own grouped section; the generic
    // "Updates" list carries any remaining (non-notification) feed items.
    const otherFeedItems = React.useMemo(
        () => feedItems.filter((item) => item.body?.kind !== 'notification'),
        [feedItems]
    );

    // Route every notification group into exactly one attention lane, then sort
    // each lane newest-first by latest activity.
    const lanes = React.useMemo(() => {
        const buckets: Record<LaneKey, NotificationSessionGroup[]> = {
            needsApproval: [],
            inProgress: [],
            toReview: [],
            other: [],
        };
        for (const group of notifications.groups) {
            const signal = signals[group.sessionId];
            const state = signal?.state ?? 'disconnected';
            const hasUnread = signal?.hasUnread ?? false;
            if (state === 'permission_required') buckets.needsApproval.push(group);
            else if (state === 'thinking') buckets.inProgress.push(group);
            else if (hasUnread) buckets.toReview.push(group);
            else buckets.other.push(group);
        }
        for (const k of Object.keys(buckets) as LaneKey[]) {
            buckets[k].sort((a, b) => b.latestAt - a.latestAt);
        }
        return buckets;
    }, [notifications.groups, signals]);

    const laneConfigs = React.useMemo<Record<LaneKey, LaneConfig>>(() => ({
        needsApproval: { title: t('inbox.laneNeedsApproval'), kind: 'permission', warning: true },
        inProgress: { title: t('inbox.laneInProgress'), kind: 'thinking' },
        toReview: { title: t('inbox.laneToReview'), kind: 'connected' },
        other: { title: t('inbox.laneOther'), kind: 'connected' },
    }), []);

    const isLoading = !feedLoaded;
    const isEmpty = !isLoading && otherFeedItems.length === 0 && notifications.isEmpty;

    const TabletHeader = () => (
        isTablet ? (
            <View style={{ backgroundColor: theme.colors.groupped.background }}>
                <Header
                    title={<HeaderTitleTablet />}
                    headerLeft={() => <HeaderLeftTablet />}
                    headerShadowVisible={false}
                    headerTransparent={true}
                />
                {realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="full" />
                )}
            </View>
        ) : null
    );

    if (isLoading) {
        return (
            <View style={styles.container}>
                <TabletHeader />
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                </View>
            </View>
        );
    }

    if (isEmpty) {
        return (
            <View style={styles.container}>
                <TabletHeader />
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    {/* Brand geometric mark instead of the brutalist placeholder —
                        an "all clear" smiley, matching the Console empty states. */}
                    <View style={styles.emptyIcon}>
                        <CyberMark size={56} />
                    </View>
                    <Text style={styles.emptyTitle}>{t('inbox.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('inbox.emptyDescription')}</Text>
                </View>
            </View>
        );
    }

    // The "Other" lane also absorbs the remaining non-notification feed items so
    // they sit at the bottom under one header.
    const hasOtherContent = lanes.other.length > 0 || otherFeedItems.length > 0;

    return (
        <View style={styles.container}>
            <TabletHeader />
            <ScrollView contentContainerStyle={{
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                width: '100%'
            }}>
                <UpdateBanner />

                {(['needsApproval', 'inProgress', 'toReview'] as LaneKey[]).map((laneKey) => (
                    lanes[laneKey].length > 0 ? (
                        <View key={laneKey}>
                            <LaneHeader config={laneConfigs[laneKey]} />
                            {lanes[laneKey].map((group) => (
                                <NotificationSessionGroupView
                                    key={group.sessionId}
                                    group={group}
                                />
                            ))}
                        </View>
                    ) : null
                ))}

                {hasOtherContent && (
                    <View>
                        <LaneHeader config={laneConfigs.other} />
                        {lanes.other.map((group) => (
                            <NotificationSessionGroupView
                                key={group.sessionId}
                                group={group}
                            />
                        ))}
                        {otherFeedItems.length > 0 && (
                            <ItemGroup>
                                {otherFeedItems.map((item) => (
                                    <FeedItemCard
                                        key={item.id}
                                        item={item}
                                    />
                                ))}
                            </ItemGroup>
                        )}
                    </View>
                )}
            </ScrollView>
        </View>
    );
});

// Tablet/desktop header (phone mode header lives in MainView). The inbox is a
// notifications surface — sessions/events that need attention — so the header
// is just a title plus a back affordance (the social "add friend" action was
// removed).
function HeaderTitleTablet() {
    const { theme } = useUnistyles();
    return (
        <Text style={{
            fontSize: 17,
            color: theme.colors.header.tint,
            fontWeight: '600',
            ...Typography.default('semiBold'),
        }}>
            {t('tabs.inbox')}
        </Text>
    );
}

function HeaderLeftTablet() {
    const router = useRouter();
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={() => { if (router.canGoBack()) router.back(); else router.navigate('/'); }}
            hitSlop={15}
            style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: 4 }}
        >
            <Ionicons name="chevron-back" size={24} color={theme.colors.header.tint} />
        </Pressable>
    );
}
