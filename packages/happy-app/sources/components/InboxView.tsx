import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useFeedItems, useFeedLoaded, useRealtimeStatus } from '@/sync/storage';
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
import { useNotificationFeed } from '@/sync/useNotificationFeed';
import { NotificationSessionGroupView } from './NotificationSessionGroup';

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
}));

interface InboxViewProps {
}

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

export const InboxView = React.memo(({}: InboxViewProps) => {
    const feedItems = useFeedItems();
    const feedLoaded = useFeedLoaded();
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const realtimeStatus = useRealtimeStatus();
    const notifications = useNotificationFeed();

    // Session notifications render in their own grouped section; the generic
    // "Updates" list carries any remaining (non-notification) feed items.
    const otherFeedItems = React.useMemo(
        () => feedItems.filter((item) => item.body?.kind !== 'notification'),
        [feedItems]
    );

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

    return (
        <View style={styles.container}>
            <TabletHeader />
            <ScrollView contentContainerStyle={{
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                width: '100%'
            }}>
                <UpdateBanner />

                {notifications.groups.length > 0 && (
                    <>
                        {notifications.groups.map((group) => (
                            <NotificationSessionGroupView
                                key={group.sessionId}
                                group={group}
                            />
                        ))}
                    </>
                )}

                {otherFeedItems.length > 0 && (
                    <ItemGroup title={t('inbox.updates')}>
                        {otherFeedItems.map((item) => (
                            <FeedItemCard
                                key={item.id}
                                item={item}
                            />
                        ))}
                    </ItemGroup>
                )}
            </ScrollView>
        </View>
    );
});
