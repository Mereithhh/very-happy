import * as React from 'react';
import { useSession, useSessionMessages, useSetting } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { ActivityIndicator, AppState, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { AgentWorkGroupView, ToolGroupView } from './ToolGroupView';
import { DuplicateSheet } from './DuplicateSheet';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { DisplayItem, ToolGroupItem, useGroupedMessages } from '@/hooks/useGroupedMessages';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { PendingPermissionsBar } from './tools/PendingPermissionsBar';

const SCROLL_THRESHOLD = 300;

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasMoreOlder, isLoadingOlder } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            hasMoreOlder={hasMoreOlder}
            isLoadingOlder={isLoadingOlder}
        />
    )
});

const ListHeader = React.memo((props: { isLoadingOlder: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    // ListFooterComponent on an inverted FlatList renders at the visual top
    // — that is exactly where the spinner for "loading older messages"
    // belongs. The spacer below keeps the header bar from clipping the
    // oldest message.
    return (
        <View>
            {props.isLoadingOlder && (
                <View style={{ paddingVertical: 12, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator size="small" />
                </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasMoreOlder: boolean,
    isLoadingOlder: boolean,
}) => {
    const { theme } = useUnistyles();
    const flatListRef = React.useRef<FlatList>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    // Tracks whether the scroll-button is currently shown, so we only call
    // setShowScrollButton when the threshold is actually crossed instead of
    // on every scroll frame (60Hz). Without this guard, the entire list
    // parent re-renders on every wheel tick.
    const showScrollButtonRef = React.useRef(false);
    const session = useSession(props.sessionId);

    // Collapse agent work between a user prompt and the final answer.
    // Nested tool groups remain expandable inside the work block.
    const groupToolCalls = useSetting('groupToolCalls');
    const hasPendingPermission = Boolean(
        session?.agentState?.requests && Object.keys(session.agentState.requests).length > 0,
    );
    const collapseCurrentTurn = session?.thinking !== true && !hasPendingPermission;

    // When a permission request appears (e.g. after navigating in from a
    // permission_request notification), bring it into view. The pending tool is
    // the newest activity, so in this inverted list it lives at the visual
    // bottom (offset 0). ChatList already auto-expands the pending group; this
    // just scrolls to it so the reviewer lands directly on the approval card.
    // Initialised to false so a session that ALREADY has a pending request on
    // mount (the notification-click case) still triggers the scroll.
    const prevHasPendingRef = React.useRef(false);
    const groupingOptions = React.useMemo(
        () => ({ collapseCurrentTurn }),
        [collapseCurrentTurn],
    );
    const displayItems = useGroupedMessages(props.messages, groupToolCalls, groupingOptions);

    // Approximate thinking duration for each thinking block: time from the
    // thinking block's createdAt to the next real output (assistant text or
    // tool call) in the same turn. messages is newest-first, so the "next"
    // output sits at a LOWER index (it arrived later in wall-clock time).
    // createdAt values are reliable server/SDK timestamps (reducer never
    // mutates them), so the delta is meaningful.
    const thinkingDurations = React.useMemo(() => {
        const map = new Map<string, number>();
        const msgs = props.messages;
        for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            if (msg.kind !== 'agent-text' || !msg.isThinking) continue;
            // Walk towards newer messages (decreasing index) for the next
            // real output. Stop at a user-text (turn boundary).
            for (let j = i - 1; j >= 0; j--) {
                const cand = msgs[j];
                if (cand.kind === 'user-text') break;
                const isRealOutput =
                    (cand.kind === 'agent-text' && !cand.isThinking && cand.text.trim().length > 0) ||
                    cand.kind === 'tool-call';
                if (isRealOutput) {
                    const delta = cand.createdAt - msg.createdAt;
                    if (delta > 0) map.set(msg.id, delta);
                    break;
                }
            }
        }
        return map;
    }, [props.messages]);

    // Id of the most recent assistant text answer; we attach the metadata
    // row (model + token usage) only to it, since latestUsage is a
    // session-level snapshot and would be misleading on older turns.
    const latestAgentTextId = React.useMemo(() => {
        for (const msg of props.messages) {
            if (msg.kind === 'agent-text' && !msg.isThinking && msg.text.trim().length > 0) {
                return msg.id;
            }
        }
        return null;
    }, [props.messages]);

    const latestUsage = session?.latestUsage ?? null;

    // Tracks which groups are explicitly collapsed. Groups start collapsed;
    // pending approval groups are the only ones we auto-expand.
    const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        for (const item of displayItems) {
            if (isCollapsibleDisplayItem(item) && !item.hasPendingPermission) {
                initial.add(item.id);
            }
        }
        return initial;
    });

    // Auto-expand groups that need user approval — but only if the user
    // hasn't manually collapsed them.
    // We track manually-collapsed IDs so we never force-reopen them.
    const manuallyCollapsedRef = React.useRef<Set<string>>(new Set());
    const initialSeenCollapsibleGroups = React.useMemo(() => {
        const initial = new Set<string>();
        for (const item of displayItems) {
            if (isCollapsibleDisplayItem(item)) {
                initial.add(item.id);
            }
        }
        return initial;
    }, []);
    const seenCollapsibleGroupsRef = React.useRef<Set<string>>(initialSeenCollapsibleGroups);

    React.useEffect(() => {
        setCollapsedGroups((prev) => {
            let changed = false;
            const next = new Set(prev);
            const seen = seenCollapsibleGroupsRef.current;
            for (const item of displayItems) {
                if (!isCollapsibleDisplayItem(item)) {
                    continue;
                }
                const isNewGroup = !seen.has(item.id);
                if (isNewGroup) {
                    seen.add(item.id);
                }
                if (item.hasPendingPermission && prev.has(item.id) && !manuallyCollapsedRef.current.has(item.id)) {
                    next.delete(item.id);
                    changed = true;
                    continue;
                }
                if (isNewGroup && !item.hasPendingPermission) {
                    next.add(item.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [displayItems]);

    // Ref so AppState handler reads fresh items without re-subscribing
    const displayItemsRef = React.useRef(displayItems);
    displayItemsRef.current = displayItems;

    // Auto-collapse completed groups when app goes to background / tab hidden
    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state !== 'active') {
                setCollapsedGroups((prev) => {
                    const next = new Set(prev);
                    for (const item of displayItemsRef.current) {
                        if (isCollapsibleDisplayItem(item) && !item.hasRunning) {
                            next.add(item.id);
                        }
                    }
                    return next;
                });
            }
        });
        return () => sub.remove();
    }, []);

    // Auto-collapse all previous groups when user sends a new message
    const latestUserMsgId = React.useMemo(() => {
        for (const msg of props.messages) {
            if (msg.kind === 'user-text') return msg.id;
        }
        return null;
    }, [props.messages]);

    const prevUserMsgIdRef = React.useRef(latestUserMsgId);
    React.useEffect(() => {
        if (latestUserMsgId && latestUserMsgId !== prevUserMsgIdRef.current) {
            prevUserMsgIdRef.current = latestUserMsgId;
            manuallyCollapsedRef.current.clear();
            setCollapsedGroups((prev) => {
                const next = new Set(prev);
                for (const item of displayItemsRef.current) {
                    if (isCollapsibleDisplayItem(item)) {
                        next.add(item.id);
                    }
                }
                return next;
            });
        }
    }, [latestUserMsgId]);

    const handleToggleGroup = useCallback((groupId: string) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
                manuallyCollapsedRef.current.delete(groupId);
            } else {
                next.add(groupId);
                manuallyCollapsedRef.current.add(groupId);
            }
            return next;
        });
    }, []);

    const keyExtractor = useCallback((item: DisplayItem) => item.id, []);

    // Long-press → fork-from-this-message. Uses the same canFork gate as
    // the rest of the fork affordances: ridden by the expResumeSession
    // experiments toggle, requires a Claude session with claudeSessionId
    // and a machine that's online. Active OR inactive — fork works either
    // way (the on-disk JSONL exists in both cases).
    const { canFork } = useSessionQuickActions(session!, {});

    const handleForkFromMessage = useCallback((messageId: string, rewindPointId: string | undefined, messageText: string) => {
        Modal.show({
            component: DuplicateSheet,
            props: {
                sessionId: props.sessionId,
                initialRewindPointId: rewindPointId,
                initialMessageText: messageText,
                initialForkedFromMessageId: messageId,
            },
        } as any);
    }, [props.sessionId]);

    const renderItem = useCallback(({ item }: { item: DisplayItem }) => {
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={!collapsedGroups.has(item.id)}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        if (item.type === 'agent-work-group') {
            return (
                <AgentWorkGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={!collapsedGroups.has(item.id)}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        const isThinking = item.message.kind === 'agent-text' && item.message.isThinking;
        const isLatestAgentText = item.message.kind === 'agent-text' && item.message.id === latestAgentTextId;
        return (
            <MessageView
                message={item.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
                thinkingDurationMs={isThinking ? thinkingDurations.get(item.message.id) : undefined}
                showMetaRow={isLatestAgentText}
                latestUsage={isLatestAgentText ? latestUsage : undefined}
                onForkFromUserMessage={canFork ? handleForkFromMessage : undefined}
            />
        );
    }, [props.metadata, props.sessionId, canFork, handleForkFromMessage, collapsedGroups, handleToggleGroup, thinkingDurations, latestAgentTextId, latestUsage]);

    // In inverted FlatList, offset 0 = latest messages (visual bottom).
    // Offset increases as user scrolls up to see older messages.
    // Auto-stick-to-bottom on new messages is handled natively by FlatList's
    // maintainVisibleContentPosition.autoscrollToBottomThreshold — no JS-side
    // scrollToOffset is needed (and running both produces a fight that drags
    // the user's viewport when reading older messages mid-stream).
    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetY = e.nativeEvent.contentOffset.y;
        const next = offsetY > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
    }, []);

    const scrollToBottom = useCallback(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, []);

    // Bring a newly-arrived pending permission into view (see ref comment above).
    React.useEffect(() => {
        if (hasPendingPermission && !prevHasPendingRef.current) {
            // Defer a tick so the auto-expanded group has been laid out.
            const id = setTimeout(() => {
                flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
            }, 120);
            prevHasPendingRef.current = hasPendingPermission;
            return () => clearTimeout(id);
        }
        prevHasPendingRef.current = hasPendingPermission;
    }, [hasPendingPermission]);

    // In an inverted FlatList, `onEndReached` fires when the user scrolls
    // past the visual top — i.e. when they want to see older history.
    // Initial fetch only loads the latest 100 messages (see
    // sync.fetchInitialLatestPage), so we lazy-load earlier pages here.
    const sessionId = props.sessionId;
    const hasMoreOlder = props.hasMoreOlder;
    const isLoadingOlder = props.isLoadingOlder;
    const handleLoadOlder = useCallback(() => {
        if (!hasMoreOlder || isLoadingOlder) return;
        void sync.loadOlderMessages(sessionId);
    }, [sessionId, hasMoreOlder, isLoadingOlder]);

    // On macOS/web, Shift+wheel swaps deltaX/deltaY — restore vertical scrolling
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const node = (flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
        if (!node) return;
        const handler = (e: WheelEvent) => {
            if (e.shiftKey && Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) < 1) {
                node.scrollTop += e.deltaX;
                e.preventDefault();
            }
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
    }, []);

    return (
        <View style={{ flex: 1 }}>
            <FlatList
                ref={flatListRef}
                data={displayItems}
                inverted={true}
                keyExtractor={keyExtractor}
                maintainVisibleContentPosition={{
                    // Anchor on the second-newest message (index 1), not the
                    // newest. The newest slot (index 0) gets a brand-new item
                    // each agent token, which would otherwise destabilise the
                    // anchor and drag the viewport up.
                    //
                    // autoscrollToTopThreshold: for INVERTED lists this is
                    // actually the auto-stick-to-visual-bottom threshold —
                    // contentOffset 0 is at the visual bottom in an inverted
                    // list, and this prop sticks the viewport to offset 0
                    // when the user is within N units of it.
                    minIndexForVisible: 1,
                    autoscrollToTopThreshold: 50,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
                ListFooterComponent={<ListHeader isLoadingOlder={props.isLoadingOlder} />}
                onEndReached={handleLoadOlder}
                onEndReachedThreshold={0.5}
            />
            {showScrollButton && (
                <View style={[styles.scrollButtonContainer, hasPendingPermission && styles.scrollButtonContainerRaised]}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.scrollButton,
                            pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                        ]}
                        onPress={scrollToBottom}
                    >
                        <Octicons name="arrow-down" size={14} color={theme.colors.text} />
                    </Pressable>
                </View>
            )}
            {/* Batch approve/deny bar — only renders when 2+ requests are
                pending (the bar self-hides below that threshold). */}
            {hasPendingPermission && (
                <View style={styles.pendingBarContainer} pointerEvents="box-none">
                    <PendingPermissionsBar sessionId={props.sessionId} />
                </View>
            )}
        </View>
    )
});

function isCollapsibleDisplayItem(item: DisplayItem): item is ToolGroupItem | Extract<DisplayItem, { type: 'agent-work-group' }> {
    return item.type === 'tool-group' || item.type === 'agent-work-group';
}

const styles = StyleSheet.create((theme) => ({
    scrollButtonContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 12,
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'box-none',
    },
    scrollButtonContainerRaised: {
        // Lift the scroll-to-bottom button above the batch permission bar.
        bottom: 68,
    },
    pendingBarContainer: {
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: 12,
        alignItems: 'stretch',
        justifyContent: 'center',
    },
    scrollButton: {
        borderRadius: 16,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2,
        shadowOpacity: theme.colors.shadow.opacity * 0.5,
        elevation: 2,
    },
    scrollButtonDefault: {
        backgroundColor: theme.colors.surface,
        opacity: 0.9,
    },
    scrollButtonPressed: {
        backgroundColor: theme.colors.surface,
        opacity: 0.7,
    },
}));
