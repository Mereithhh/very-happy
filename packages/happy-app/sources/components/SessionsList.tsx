import React from 'react';
import { View, Pressable, FlatList, Platform, TextInput } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, SessionRowData, useSessionListViewData } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { type SessionState, formatLastSeen, vibingMessages } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { TerminalsSection } from './TerminalsSection';
import { layout } from './layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';

type SessionStatusFilter = 'all' | 'active' | 'archived';

/**
 * Filter the session list view by free-text query and status. Operates on the
 * raw view items so it can show/hide archived sessions independently of the
 * persisted hideInactiveSessions setting. Headers / project groups that end up
 * with no sessions beneath them are dropped so the list stays clean.
 */
function filterSessionListData(
    data: SessionListViewItem[],
    query: string,
    statusFilter: SessionStatusFilter,
): SessionListViewItem[] {
    const normalizedQuery = query.trim().toLowerCase();
    const hasQuery = normalizedQuery.length > 0;

    const matchesSession = (session: SessionRowData): boolean => {
        if (statusFilter === 'active' && !session.active) return false;
        if (statusFilter === 'archived' && session.active) return false;
        if (!hasQuery) return true;
        const haystacks = [
            session.name,
            session.subtitle,
            session.path ?? '',
        ];
        return haystacks.some((value) => value.toLowerCase().includes(normalizedQuery));
    };

    const result: SessionListViewItem[] = [];
    // Defer headers / project groups until we know a session follows them.
    let pendingHeader: SessionListViewItem | null = null;
    let pendingProjectGroup: SessionListViewItem | null = null;

    const flushPending = () => {
        if (pendingHeader) {
            result.push(pendingHeader);
            pendingHeader = null;
        }
        if (pendingProjectGroup) {
            result.push(pendingProjectGroup);
            pendingProjectGroup = null;
        }
    };

    for (const item of data) {
        switch (item.type) {
            case 'header':
                pendingHeader = item;
                pendingProjectGroup = null;
                break;
            case 'project-group':
                pendingProjectGroup = item;
                break;
            case 'active-sessions': {
                const sessions = item.sessions.filter(matchesSession);
                if (sessions.length > 0) {
                    result.push({ type: 'active-sessions', sessions });
                }
                break;
            }
            case 'archive-toggle':
                // The status segmented control supersedes the inline toggle while
                // filtering, so drop it here.
                break;
            case 'session':
                if (matchesSession(item.session)) {
                    flushPending();
                    result.push(item);
                }
                break;
        }
    }

    return result;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    projectGroup: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
    },
    projectGroupTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    projectGroupSubtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    sessionItem: {
        height: 88,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.surface,
        // Console list: flat, hairline-separated rows. A transparent left edge
        // on every row means the selected teal edge causes no layout shift.
        borderLeftWidth: 3,
        borderLeftColor: 'transparent',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    sessionItemContainer: {
        marginHorizontal: 0,
        marginBottom: 0,
        overflow: 'hidden',
    },
    // Flat list: no per-group card rounding or gaps; the section header gives
    // separation. Kept as (mostly) no-ops so the render logic that toggles
    // isFirst/isLast/isSingle needs no changes.
    sessionItemFirst: {},
    sessionItemLast: {},
    sessionItemSingle: {},
    sessionItemContainerFirst: {},
    sessionItemContainerLast: {
        marginBottom: 8,
    },
    sessionItemContainerSingle: {
        marginBottom: 8,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
        borderLeftColor: theme.colors.status.connected, // teal "active" edge
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionSubtitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginBottom: 4,
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    avatarContainer: {
        position: 'relative',
        width: 48,
        height: 48,
    },
    draftIconContainer: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconOverlay: {
        color: theme.colors.textSecondary,
    },
    artifactsSection: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        backgroundColor: theme.colors.groupped.background,
    },
    filterBar: {
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 8,
        gap: 8,
        backgroundColor: theme.colors.groupped.background,
    },
    searchField: {
        flexDirection: 'row',
        alignItems: 'center',
        height: 36,
        borderRadius: 10,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    searchIcon: {
        marginRight: 6,
    },
    searchInput: {
        flex: 1,
        fontSize: 14,
        paddingVertical: 0,
        color: theme.colors.text,
        ...Typography.default(),
    },
    searchClear: {
        marginLeft: 6,
    },
    segmentedControl: {
        flexDirection: 'row',
        borderRadius: 9,
        padding: 2,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    segment: {
        flex: 1,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
    },
    segmentActive: {
        backgroundColor: theme.colors.surface,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
        elevation: 1,
    },
    segmentText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    segmentTextActive: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    emptyResults: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingBottom: 48,
        gap: 10,
    },
    emptyResultsText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    archiveToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 16,
    },
    archiveToggleLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.groupped.sectionTitle,
        opacity: 0.3,
    },
    archiveToggleText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        paddingHorizontal: 12,
        ...Typography.default('semiBold'),
    },
}));

export function SessionsList() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const visibleData = useVisibleSessionListViewData();
    const rawData = useSessionListViewData();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const toggleArchived = React.useCallback(() => {
        setHideInactiveSessions(!hideInactiveSessions);
    }, [hideInactiveSessions, setHideInactiveSessions]);

    const [searchQuery, setSearchQuery] = React.useState('');
    // Default the sidebar to the "Active" segment so opening it surfaces live
    // sessions first; users can switch to All / Archived from the control.
    const [statusFilter, setStatusFilter] = React.useState<SessionStatusFilter>('active');
    const isFiltering = searchQuery.trim().length > 0 || statusFilter !== 'all';

    // While filtering we work off the raw list (so archived sessions can be
    // shown regardless of the persisted toggle); otherwise keep the existing
    // hideInactiveSessions-driven view untouched.
    const data = React.useMemo(() => {
        if (!isFiltering) return visibleData;
        if (!rawData) return rawData;
        return filterSessionListData(rawData, searchQuery, statusFilter);
    }, [isFiltering, visibleData, rawData, searchQuery, statusFilter]);

    const statusFilterOptions = React.useMemo(() => ([
        { value: 'all' as const, label: t('sidebar.filterAll') },
        { value: 'active' as const, label: t('sidebar.filterActive') },
        { value: 'archived' as const, label: t('sidebar.filterArchived') },
    ]), []);
    // Selection is derived once from pathname so the data array stays stable
    // across navigations. This keeps FlatList virtualization intact: only
    // the previously- and newly-selected rows re-render, instead of the
    // whole visible window.
    const selectedSessionId = React.useMemo<string | undefined>(() => {
        if (!isTablet) return undefined;
        if (!pathname.startsWith('/session/')) return undefined;
        return pathname.split('/')[2];
    }, [isTablet, pathname]);

    // Request review
    React.useEffect(() => {
        if (data && data.length > 0) {
            requestReview();
        }
    }, [data && data.length > 0]);

    // Early return if no data yet
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';
            case 'archive-toggle': return 'archive-toggle';
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'session': return `session-${item.session.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item, index }: { item: SessionListViewItem, index: number }) => {
        switch (item.type) {
            case 'header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>
                            {item.title}
                        </Text>
                    </View>
                );

            case 'archive-toggle':
                return (
                    <Pressable style={styles.archiveToggle} onPress={toggleArchived}>
                        <View style={styles.archiveToggleLine} />
                        <Text style={styles.archiveToggleText}>
                            {item.hidden ? t('sidebar.showArchived') : t('sidebar.hideArchived')}
                        </Text>
                        <View style={styles.archiveToggleLine} />
                    </Pressable>
                );

            case 'active-sessions':
                return (
                    <ActiveSessionsGroupCompact
                        sessions={item.sessions}
                        selectedSessionId={selectedSessionId}
                    />
                );

            case 'project-group':
                return (
                    <View style={styles.projectGroup}>
                        <Text style={styles.projectGroupTitle}>
                            {item.displayPath}
                        </Text>
                        <Text style={styles.projectGroupSubtitle}>
                            {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
                        </Text>
                    </View>
                );

            case 'session':
                // Determine card styling based on position within date group
                const prevItem = index > 0 ? data[index - 1] : null;
                const nextItem = index < data.length - 1 ? data[index + 1] : null;

                const isFirst = prevItem?.type === 'header';
                const isLast = nextItem?.type === 'header' || nextItem == null || nextItem?.type === 'active-sessions';
                const isSingle = isFirst && isLast;
                const selected = item.session.id === selectedSessionId;

                return (
                    <SessionItem
                        session={item.session}
                        selected={selected}
                        isFirst={isFirst}
                        isLast={isLast}
                        isSingle={isSingle}
                    />
                );
        }
    }, [selectedSessionId, data, toggleArchived]);


    // Remove this section as we'll use FlatList for all items now


    const HeaderComponent = React.useCallback(() => {
        return (
            <>
                <UpdateBanner />
                {/* Terminal sessions live at the top of the same list (web). */}
                <TerminalsSection />
            </>
        );
    }, []);

    // Footer removed - all sessions now shown inline

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <View style={styles.filterBar}>
                    <View style={styles.searchField}>
                        <Ionicons
                            name="search"
                            size={16}
                            color={theme.colors.textSecondary}
                            style={styles.searchIcon}
                        />
                        <TextInput
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            placeholder={t('sidebar.searchPlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            style={styles.searchInput}
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="search"
                            clearButtonMode="while-editing"
                        />
                        {searchQuery.length > 0 && Platform.OS !== 'ios' && (
                            <Pressable
                                onPress={() => setSearchQuery('')}
                                hitSlop={8}
                                style={styles.searchClear}
                            >
                                <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                            </Pressable>
                        )}
                    </View>
                    <View style={styles.segmentedControl}>
                        {statusFilterOptions.map((option) => {
                            const active = statusFilter === option.value;
                            return (
                                <Pressable
                                    key={option.value}
                                    onPress={() => setStatusFilter(option.value)}
                                    style={[
                                        styles.segment,
                                        active && styles.segmentActive,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.segmentText,
                                            active && styles.segmentTextActive,
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {option.label}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>
                {data.length === 0 && isFiltering ? (
                    <View style={styles.emptyResults}>
                        <Ionicons name="search-outline" size={28} color={theme.colors.textSecondary} />
                        <Text style={styles.emptyResultsText}>{t('sidebar.noResults')}</Text>
                    </View>
                ) : (
                    <FlatList
                        data={data}
                        renderItem={renderItem}
                        keyExtractor={keyExtractor}
                        extraData={selectedSessionId}
                        contentContainerStyle={{ paddingBottom: safeArea.bottom + 128, maxWidth: layout.maxWidth }}
                        ListHeaderComponent={HeaderComponent}
                        keyboardShouldPersistTaps="handled"
                        windowSize={5}
                        maxToRenderPerBatch={8}
                        initialNumToRender={12}
                    />
                )}
            </View>
        </View>
    );
}

const getStatusConfig = (theme: any): Record<SessionState, { color: string; dotColor: string; isPulsing: boolean; isConnected: boolean }> => ({
    disconnected: { color: theme.colors.status.disconnected, dotColor: theme.colors.status.disconnected, isPulsing: false, isConnected: false },
    thinking: { color: theme.colors.status.connected, dotColor: theme.colors.status.connected, isPulsing: true, isConnected: true },
    waiting: { color: theme.colors.status.connected, dotColor: theme.colors.status.connected, isPulsing: false, isConnected: true },
    permission_required: { color: theme.colors.status.connecting, dotColor: theme.colors.status.connecting, isPulsing: true, isConnected: true },
});

const SessionItem = React.memo(({ session, selected, isFirst, isLast, isSingle }: {
    session: SessionRowData;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const baseStatus = getStatusConfig(theme)[session.state];
    // Override to solid accent when session has unread results
    const status = session.hasUnread
        ? { ...baseStatus, color: theme.colors.status.connected, dotColor: theme.colors.status.connected, isPulsing: false, isConnected: baseStatus.isConnected }
        : baseStatus;

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [session.state]);

    const statusText = session.hasUnread
        ? t('status.unread')
        : session.state === 'thinking'
            ? vibingMessage
            : session.state === 'disconnected'
                ? t('status.lastSeen', { time: formatLastSeen(session.activeAt!, false) })
                : session.state === 'permission_required'
                    ? t('status.permissionRequired')
                    : t('status.online');

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const showActionAlert = useSessionActionAlert(session.id);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {
        onLongPress: showActionAlert,
    };

    return (
        <View style={[
            styles.sessionItemContainer,
            isSingle ? styles.sessionItemContainerSingle :
                isFirst ? styles.sessionItemContainerFirst :
                    isLast ? styles.sessionItemContainerLast : {}
        ]}>
        <Pressable
            style={[
                styles.sessionItem,
                selected && styles.sessionItemSelected,
                isSingle ? styles.sessionItemSingle :
                    isFirst ? styles.sessionItemFirst :
                        isLast ? styles.sessionItemLast : {}
            ]}
            onPress={handlePress}
            {...menuProps}
        >
            <View style={styles.avatarContainer}>
                <Avatar id={session.avatarId} size={48} monochrome={!status.isConnected} flavor={session.flavor} />
                {session.hasDraft && (
                    <View style={styles.draftIconContainer}>
                        <Ionicons
                            name="create-outline"
                            size={12}
                            style={styles.draftIconOverlay}
                        />
                    </View>
                )}
            </View>
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                    ]} numberOfLines={1}>
                        {session.name}
                    </Text>
                </View>

                {session.path ? (
                    <View style={styles.sessionSubtitleRow}>
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {session.path.split(/[/\\]/).filter(Boolean).pop()}
                        </Text>
                    </View>
                ) : (
                    <Text style={styles.sessionSubtitle} numberOfLines={1}>
                        {session.subtitle}
                    </Text>
                )}

                <View style={styles.statusRow}>
                    <View style={styles.statusDotContainer}>
                        <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                    </View>
                    <Text style={[
                        styles.statusText,
                        { color: status.color }
                    ]}>
                        {statusText}
                    </Text>
                </View>
            </View>
        </Pressable>
        {Platform.OS === 'web' && (
            <SessionActionsPopover
                anchor={actionsAnchor}
                onClose={() => setActionsAnchor(null)}
                sessionId={session.id}
                visible={!!actionsAnchor}
            />
        )}
        </View>
    );
});
