import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator, Platform, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import {
    AgentWorkGroupItem,
    ToolGroupItem,
    ToolDisplayItem,
    ToolGroupStats,
    formatWorkDuration,
    generateGroupStats,
    generateGroupSummary,
    groupToolCallsForDisplay,
} from '@/hooks/useGroupedMessages';
import { MessageView } from './MessageView';
import { Metadata } from '@/sync/storageTypes';
import { layout } from './layout';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { t } from '@/text';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { getToolSummaryCategory, getToolSummaryDetail, ToolSummaryCategory } from '@/utils/toolDisplay';
import { formatMCPTitle } from './tools/views/MCPToolView';

type ThemeColors = ReturnType<typeof useUnistyles>['theme']['colors'];

/**
 * "Console" spine colour for a tool *group* container. The left accent ridge
 * encodes the machine's working state at a glance:
 *  - running  -> teal (the only time it lights up; "machine is working")
 *  - all error -> destructive
 *  - mixed (some ok, some failed) -> warning
 *  - done / static -> neutral divider (teal is reserved for live only)
 */
function getGroupSpineColor(colors: ThemeColors, hasRunning: boolean, stats: ToolGroupStats): string {
    if (hasRunning) {
        return colors.status.connected;
    }
    if (stats.error > 0) {
        // Partial failure (some completed) reads as warning; a wholly-failed
        // group reads as a hard error.
        return stats.completed > 0 ? colors.warning : colors.textDestructive;
    }
    return colors.divider;
}

/**
 * "Console" spine colour for a single tool row, driven by that tool's own state.
 */
function getToolSpineColor(colors: ThemeColors, state: 'running' | 'completed' | 'error'): string {
    switch (state) {
        case 'running':
            return colors.status.connected;
        case 'error':
            return colors.textDestructive;
        default:
            return colors.divider;
    }
}

interface ToolGroupViewProps {
    group: ToolGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    onToggle: () => void;
    nested?: boolean;
    hideSingleToolChildren?: boolean;
}

export const ToolGroupView = React.memo<ToolGroupViewProps>((props) => {
    const { group, metadata, sessionId, expanded, onToggle, nested, hideSingleToolChildren } = props;
    const { theme } = useUnistyles();
    const summary = React.useMemo(() => generateGroupSummary(group.messages), [group.messages]);
    const summaryCategory = React.useMemo(() => getGroupSummaryCategory(group.messages), [group.messages]);
    const stats = React.useMemo(() => generateGroupStats(group.messages), [group.messages]);
    const spineColor = getGroupSpineColor(theme.colors, group.hasRunning, stats);
    const runningStartedAt = React.useMemo(
        () => (group.hasRunning ? getRunningStartedAt(group.messages) : null),
        [group.hasRunning, group.messages],
    );
    const iconCategories = React.useMemo(() => getGroupIconCategories(group.messages), [group.messages]);
    const suppressChildren = hideSingleToolChildren && group.messages.length === 1 && group.messages[0]?.kind === 'tool-call';
    const singleToolMessage = suppressChildren && group.messages[0]?.kind === 'tool-call'
        ? group.messages[0]
        : null;
    // Single-tool groups expand inline (full tool body below the header)
    // instead of navigating to a dedicated full-screen page.
    const handleSingleToolPress = onToggle;
    const renderGroupMessage = React.useCallback((msg: Message) => (
        <ToolGroupMessageRow
            key={msg.id}
            message={msg}
            metadata={metadata}
            sessionId={sessionId}
        />
    ), [metadata, sessionId]);

    const body = (
        <View style={[nested ? styles.nestedInnerContainer : styles.innerContainer, { borderLeftColor: spineColor }]}>
            <CollapseHeader
                expanded={expanded}
                hasRunning={group.hasRunning}
                label={summary}
                onPress={singleToolMessage ? handleSingleToolPress : onToggle}
                category={summaryCategory}
                showChevron
                stats={singleToolMessage ? undefined : stats}
                iconCategories={singleToolMessage ? undefined : iconCategories}
                runningStartedAt={runningStartedAt}
            />
            {expanded && (
                <View style={styles.content}>
                    {singleToolMessage ? (
                        // The header already is the single tool's summary, so
                        // expand straight to its full body (no nested summary row).
                        <MessageView
                            message={singleToolMessage}
                            metadata={metadata}
                            sessionId={sessionId}
                        />
                    ) : (
                        group.messages.map(renderGroupMessage)
                    )}
                </View>
            )}
        </View>
    );

    if (nested) {
        return (
            <View style={styles.nestedOuterContainer}>
                {body}
            </View>
        );
    }

    return (
        <View style={styles.outerContainer}>
            {body}
        </View>
    );
});

interface AgentWorkGroupViewProps {
    group: AgentWorkGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    onToggle: () => void;
}

export const AgentWorkGroupView = React.memo<AgentWorkGroupViewProps>((props) => {
    const { group, metadata, sessionId, expanded, onToggle } = props;
    const { theme } = useUnistyles();
    const stats = React.useMemo(() => generateGroupStats(group.messages), [group.messages]);
    const spineColor = getGroupSpineColor(theme.colors, group.hasRunning, stats);
    const runningElapsedSeconds = useElapsedTime(group.completedAt === null ? group.startedAt : null);
    const durationMs = group.completedAt === null
        ? runningElapsedSeconds * 1000
        : group.completedAt - group.startedAt;
    const label = t('toolGroup.workedFor', { duration: formatWorkDuration(durationMs) });
    const nestedItemsNewestFirst = React.useMemo(
        () => groupToolCallsForDisplay(group.messages, true, { groupSingleToolCalls: true }),
        [group.messages],
    );
    const nestedItems = React.useMemo(
        () => [...nestedItemsNewestFirst].reverse(),
        [nestedItemsNewestFirst],
    );

    const [collapsedToolGroups, setCollapsedToolGroups] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        for (const item of nestedItemsNewestFirst) {
            if (item.type === 'tool-group' && !item.hasPendingPermission) {
                initial.add(item.id);
            }
        }
        return initial;
    });
    const manuallyCollapsedToolGroupsRef = React.useRef<Set<string>>(new Set());

    React.useEffect(() => {
        setCollapsedToolGroups((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const item of nestedItemsNewestFirst) {
                if (item.type !== 'tool-group') {
                    continue;
                }
                if (item.hasPendingPermission && next.has(item.id) && !manuallyCollapsedToolGroupsRef.current.has(item.id)) {
                    next.delete(item.id);
                    changed = true;
                    continue;
                }
                if (!item.hasPendingPermission && !next.has(item.id)) {
                    next.add(item.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [nestedItemsNewestFirst]);

    const handleToggleNestedGroup = React.useCallback((groupId: string) => {
        setCollapsedToolGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
                manuallyCollapsedToolGroupsRef.current.delete(groupId);
            } else {
                next.add(groupId);
                manuallyCollapsedToolGroupsRef.current.add(groupId);
            }
            return next;
        });
    }, []);

    const renderNestedItem = React.useCallback((item: ToolDisplayItem) => {
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    key={item.id}
                    group={item}
                    metadata={metadata}
                    sessionId={sessionId}
                    expanded={!collapsedToolGroups.has(item.id)}
                    onToggle={() => handleToggleNestedGroup(item.id)}
                    nested
                    hideSingleToolChildren
                />
            );
        }
        return (
            <MessageView
                key={item.id}
                message={item.message}
                metadata={metadata}
                sessionId={sessionId}
            />
        );
    }, [collapsedToolGroups, handleToggleNestedGroup, metadata, sessionId]);

    return (
        <View style={styles.outerContainer}>
            <View style={[styles.innerContainer, { borderLeftColor: spineColor }]}>
                <CollapseHeader
                    expanded={expanded}
                    hasRunning={group.hasRunning}
                    label={label}
                    onPress={onToggle}
                />
                {expanded && (
                    <View style={styles.content}>
                        {nestedItems.map(renderNestedItem)}
                    </View>
                )}
            </View>
        </View>
    );
});

function CollapseHeader(props: {
    expanded: boolean;
    hasRunning: boolean;
    label: string;
    onPress: () => void;
    category?: ToolSummaryCategory | null;
    showChevron?: boolean;
    disabled?: boolean;
    stats?: ToolGroupStats;
    iconCategories?: ToolSummaryCategory[];
    runningStartedAt?: number | null;
}) {
    const { theme } = useUnistyles();
    const showChevron = props.showChevron ?? true;
    // Live elapsed for running groups so a long Bash isn't reduced to a bare
    // spinner. A bare formatted duration (e.g. "42s") needs no translation key.
    const runningElapsedSeconds = useElapsedTime(props.hasRunning ? (props.runningStartedAt ?? null) : null);
    const runningLabel = props.hasRunning && props.runningStartedAt != null
        ? formatWorkDuration(runningElapsedSeconds * 1000)
        : null;
    // The leading per-category icon strip replaces the single summary icon when
    // a group spans multiple distinct tool categories, giving an at-a-glance
    // sense of what ran without expanding.
    const iconStrip = props.iconCategories && props.iconCategories.length > 1
        ? props.iconCategories
        : null;
    const content = (
        <>
            {iconStrip ? (
                <View style={styles.headerIconStrip}>
                    {iconStrip.map((category, index) => (
                        <View key={`${category}-${index}`} style={styles.headerIconStripItem}>
                            <ToolSummaryIcon category={category} color={theme.colors.textSecondary} />
                        </View>
                    ))}
                </View>
            ) : props.category ? (
                <View style={styles.headerIcon}>
                    <ToolSummaryIcon category={props.category} color={theme.colors.textSecondary} />
                </View>
            ) : null}
            <Text style={styles.summaryText} numberOfLines={1}>
                {props.label}
            </Text>
            {props.stats ? (
                <GroupStatusPills stats={props.stats} />
            ) : null}
            {runningLabel ? (
                <Text style={styles.headerRunningElapsed} numberOfLines={1}>
                    {runningLabel}
                </Text>
            ) : null}
            {props.hasRunning && (
                <ActivityIndicator
                    size="small"
                    color={theme.colors.status.connected}
                    style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
                />
            )}
            {showChevron ? (
                <Ionicons
                    name={props.expanded ? 'chevron-down' : 'chevron-forward'}
                    size={13}
                    color={theme.colors.textSecondary}
                />
            ) : null}
        </>
    );

    if (props.disabled) {
        return (
            <View style={styles.header}>
                {content}
            </View>
        );
    }

    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.header,
                pressed && styles.headerPressed,
            ]}
        >
            {content}
        </Pressable>
    );
}

function ToolGroupMessageRow(props: {
    message: Message;
    metadata: Metadata | null;
    sessionId: string;
}) {
    if (props.message.kind !== 'tool-call') {
        return (
            <MessageView
                message={props.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
            />
        );
    }

    const shouldRenderFullTool = props.message.tool.permission?.status === 'pending'
        || props.message.tool.name === 'AskUserQuestion';
    if (shouldRenderFullTool) {
        return (
            <MessageView
                message={props.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
            />
        );
    }

    return (
        <ToolSummaryRow
            message={props.message}
            metadata={props.metadata}
            sessionId={props.sessionId}
        />
    );
}

function ToolSummaryRow(props: {
    message: ToolCallMessage;
    metadata: Metadata | null;
    sessionId: string;
}) {
    const { theme } = useUnistyles();
    const { tool } = props.message;
    const category = getToolSummaryCategory(tool.name);
    const detail = getToolSummaryDetail(tool);
    const title = getToolRowTitle(category, tool.name);
    const durationLabel = getToolDurationLabel(tool);
    const isPressable = Boolean(props.sessionId);
    const spineColor = getToolSpineColor(theme.colors, tool.state);

    // Inline expansion: tapping the compact summary row reveals the full tool
    // (input/output/diff) in place via the regular ToolView, instead of jumping
    // to a dedicated full-screen page.
    const [expanded, setExpanded] = React.useState(false);
    const handlePress = React.useCallback(() => {
        setExpanded((e) => !e);
    }, []);

    const content = (
        <>
            <View style={styles.toolSummaryIcon}>
                <ToolSummaryIcon category={category} color={theme.colors.textSecondary} />
            </View>
            <Text style={styles.toolSummaryTitle} numberOfLines={1}>
                {title}
            </Text>
            {detail ? (
                <View style={styles.toolSummaryDetailPill}>
                    <Text style={styles.toolSummaryDetailText} numberOfLines={1}>
                        {detail}
                    </Text>
                </View>
            ) : null}
            <View style={styles.toolSummaryTrailing}>
                {durationLabel ? (
                    <Text style={styles.toolSummaryDuration} numberOfLines={1}>
                        {durationLabel}
                    </Text>
                ) : null}
                <ToolStatusIndicator state={tool.state} />
                {isPressable ? (
                    <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={13}
                        color={theme.colors.textSecondary}
                    />
                ) : null}
            </View>
        </>
    );

    if (!isPressable) {
        return (
            <View style={[styles.toolSummaryRow, { borderLeftColor: spineColor }]}>
                {content}
            </View>
        );
    }

    return (
        <View>
            <Pressable
                onPress={handlePress}
                style={({ pressed }) => [
                    styles.toolSummaryRow,
                    { borderLeftColor: spineColor },
                    pressed && styles.toolSummaryRowPressed,
                ]}
            >
                {content}
            </Pressable>
            {expanded ? (
                // Cap the inline tool body so a giant stdout can't blow out the
                // chat; overflow scrolls within the block.
                <ScrollView
                    style={styles.toolSummaryExpanded}
                    contentContainerStyle={styles.toolSummaryExpandedContent}
                    nestedScrollEnabled
                >
                    <MessageView
                        message={props.message}
                        metadata={props.metadata}
                        sessionId={props.sessionId}
                    />
                </ScrollView>
            ) : null}
        </View>
    );
}

function ToolSummaryIcon(props: {
    category: ToolSummaryCategory;
    color: string;
}) {
    switch (props.category) {
        case 'terminal':
            return <Octicons name="terminal" size={12} color={props.color} />;
        case 'edit':
            return <Octicons name="file-diff" size={12} color={props.color} />;
        case 'read':
            return <Octicons name="eye" size={12} color={props.color} />;
        case 'search':
            return <Octicons name="search" size={12} color={props.color} />;
        case 'web':
            return <Ionicons name="globe-outline" size={13} color={props.color} />;
        case 'task':
            return <Octicons name="rocket" size={12} color={props.color} />;
        default:
            return <Ionicons name="construct-outline" size={13} color={props.color} />;
    }
}

/**
 * Distinct tool categories in the group, in first-seen order. Drives the
 * collapsed header icon strip. Capped so the header never overflows; the
 * remainder is implied by the summary count.
 */
const MAX_HEADER_ICONS = 5;
function getGroupIconCategories(messages: Message[]): ToolSummaryCategory[] {
    const seen = new Set<ToolSummaryCategory>();
    const result: ToolSummaryCategory[] = [];
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        const category = getToolSummaryCategory(message.tool.name);
        if (seen.has(category)) continue;
        seen.add(category);
        result.push(category);
        if (result.length >= MAX_HEADER_ICONS) break;
    }
    return result;
}

/**
 * Language-free outcome summary for the collapsed header: a coloured dot per
 * non-zero state with its count (e.g. ● 5  ● 1). Running is omitted here since
 * the header already shows a live spinner.
 */
function GroupStatusPills(props: { stats: ToolGroupStats }) {
    const { theme } = useUnistyles();
    const { completed, error } = props.stats;
    if (error === 0) {
        // All-success groups stay quiet — the summary line already conveys it.
        return null;
    }
    return (
        <View style={styles.statusPills}>
            {completed > 0 ? (
                <View style={styles.statusPill}>
                    <View style={[styles.statusPillDot, { backgroundColor: theme.colors.success }]} />
                    <Text style={styles.statusPillText}>{completed}</Text>
                </View>
            ) : null}
            {error > 0 ? (
                <View style={styles.statusPill}>
                    <View style={[styles.statusPillDot, { backgroundColor: theme.colors.textDestructive }]} />
                    <Text style={[styles.statusPillText, { color: theme.colors.textDestructive }]}>{error}</Text>
                </View>
            ) : null}
        </View>
    );
}

function ToolStatusIndicator(props: { state: 'running' | 'completed' | 'error' }) {
    const { theme } = useUnistyles();
    if (props.state === 'running') {
        return (
            <ActivityIndicator
                size="small"
                color={theme.colors.textSecondary}
                style={{ transform: [{ scaleX: 0.6 }, { scaleY: 0.6 }] }}
            />
        );
    }
    const color = props.state === 'error' ? theme.colors.textDestructive : theme.colors.success;
    return (
        <View style={[styles.toolStatusDot, { backgroundColor: color }]} />
    );
}

/**
 * Earliest start time among the group's still-running tools, so the header can
 * show how long the live work has been going. Falls back to null when no
 * running tool carries a startedAt.
 */
function getRunningStartedAt(messages: Message[]): number | null {
    let earliest: number | null = null;
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        if (message.tool.state !== 'running') continue;
        const startedAt = message.tool.startedAt;
        if (typeof startedAt !== 'number') continue;
        if (earliest === null || startedAt < earliest) {
            earliest = startedAt;
        }
    }
    return earliest;
}

function getToolDurationLabel(tool: ToolCallMessage['tool']): string | null {
    if (tool.state === 'running') return null;
    if (typeof tool.startedAt !== 'number' || typeof tool.completedAt !== 'number') return null;
    const durationMs = tool.completedAt - tool.startedAt;
    if (durationMs <= 0) return null;
    return formatWorkDuration(durationMs);
}

function getGroupSummaryCategory(messages: Message[]): ToolSummaryCategory | null {
    const categories = new Set<ToolSummaryCategory>();
    for (const message of messages) {
        if (message.kind === 'tool-call') {
            categories.add(getToolSummaryCategory(message.tool.name));
        }
    }
    if (categories.size === 1) {
        return categories.values().next().value ?? null;
    }
    return categories.size > 1 ? 'other' : null;
}

function getToolRowTitle(category: ToolSummaryCategory, toolName: string): string {
    if (toolName.startsWith('mcp__')) {
        return formatMCPTitle(toolName);
    }

    switch (category) {
        case 'terminal':
            return t('tools.names.terminal');
        case 'edit':
            return t('toolGroup.editedFile');
        case 'read':
            return t('tools.names.readFile');
        case 'search':
            return t('tools.names.search');
        case 'web':
            return t('tools.names.fetchUrl');
        case 'task':
            return t('tools.names.task');
        default:
            return toolName;
    }
}

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    innerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        maxWidth: layout.maxWidth,
        marginVertical: 6,
        overflow: 'hidden',
        // "Console" accent spine: 2px left ridge, colour set inline per state.
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.divider,
        paddingLeft: 8,
    },
    nestedOuterContainer: {
        overflow: 'hidden',
    },
    nestedInnerContainer: {
        minWidth: 0,
        overflow: 'hidden',
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.divider,
        paddingLeft: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'stretch',
        marginHorizontal: 16,
        minHeight: 24,
        paddingVertical: 2,
        borderRadius: 4,
    },
    headerPressed: {
        opacity: 0.6,
    },
    headerIcon: {
        width: 14,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    headerIconStrip: {
        flexDirection: 'row',
        alignItems: 'center',
        height: 18,
        gap: 4,
        flexShrink: 0,
    },
    headerIconStripItem: {
        width: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusPills: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    statusPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    statusPillDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    statusPillText: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
    },
    summaryText: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    headerRunningElapsed: {
        flexShrink: 0,
        fontSize: 11,
        lineHeight: 16,
        color: theme.colors.status.connected,
        fontVariant: ['tabular-nums'],
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    content: {
        marginTop: 2,
        gap: 2,
    },
    toolSummaryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 24,
        marginHorizontal: 16,
        paddingVertical: 2,
        paddingLeft: 8,
        borderRadius: 4,
        overflow: 'hidden',
        // Per-tool "Console" spine: 2px left ridge, colour set inline per state.
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.divider,
    },
    toolSummaryRowPressed: {
        opacity: 0.65,
    },
    toolSummaryExpanded: {
        marginHorizontal: 8,
        // Cap runaway stdout/diff height; scroll inside the block instead.
        maxHeight: 200,
    },
    toolSummaryExpandedContent: {
        flexGrow: 1,
    },
    toolSummaryIcon: {
        width: 14,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    toolSummaryTitle: {
        flexShrink: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        // "Console" language: the tool name reads as machine output (mono).
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    toolSummaryDetailPill: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        borderRadius: 3,
        paddingHorizontal: 4,
        paddingVertical: 1,
        backgroundColor: theme.colors.surfaceHighest,
    },
    toolSummaryDetailText: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    toolSummaryTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginLeft: 'auto',
        paddingLeft: 4,
        flexShrink: 0,
    },
    toolSummaryDuration: {
        fontSize: 11,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        fontVariant: ['tabular-nums'],
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    toolStatusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
}));
