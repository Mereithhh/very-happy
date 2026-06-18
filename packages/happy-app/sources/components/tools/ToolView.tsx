import * as React from 'react';
import { Text, View, TouchableOpacity, ActivityIndicator, Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { getToolViewComponent } from './views/_all';
import { Message, ToolCall } from '@/sync/typesMessage';
import { CodeView } from '../CodeView';
import { ToolSectionView } from './ToolSectionView';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { ToolError } from './ToolError';
import { knownTools } from '@/components/tools/knownTools';
import { Metadata } from '@/sync/storageTypes';
import { useRouter } from 'expo-router';
import { PermissionFooter } from './PermissionFooter';
import { parseToolUseError } from '@/utils/toolErrorParser';
import { formatMCPTitle } from './views/MCPToolView';
import { t } from '@/text';
import { getTerminalToolCommand, shouldRenderToolCardHeader } from '@/utils/toolDisplay';

interface ToolViewProps {
    metadata: Metadata | null;
    tool: ToolCall;
    messages?: Message[];
    onPress?: () => void;
    sessionId?: string;
    messageId?: string;
}

export const ToolView = React.memo<ToolViewProps>((props) => {
    const { tool, onPress, sessionId, messageId } = props;
    const router = useRouter();
    const { theme } = useUnistyles();

    // Inline expand state. Tapping the header reveals the full tool detail in
    // place (input / output / error) instead of pushing a full-screen route.
    const [expanded, setExpanded] = React.useState(false);

    // For file-editing tools, navigate to the dedicated file route instead of
    // expanding inline — the file diff view is a better experience there.
    const fileEditTools = ['Edit', 'MultiEdit', 'Write'];
    const isFileEditTool = fileEditTools.includes(tool.name);
    const filePath = isFileEditTool && typeof tool.input?.file_path === 'string' ? tool.input.file_path : null;

    // Default header press: explicit onPress wins; file-edit tools navigate;
    // everything else toggles inline expansion.
    const handlePress = React.useCallback(() => {
        if (onPress) {
            onPress();
        } else if (sessionId && filePath) {
            router.push(`/session/${sessionId}/file?path=${btoa(filePath)}`);
        } else {
            setExpanded((e) => !e);
        }
    }, [onPress, sessionId, filePath, router]);

    // Optional escape hatch to the full-screen detail page from the expanded
    // region (kept for deep-linking / sharing).
    const openFullPage = React.useCallback(() => {
        if (sessionId && messageId) {
            router.push(`/session/${sessionId}/message/${messageId}`);
        }
    }, [sessionId, messageId, router]);

    // Header is pressable when it has any action: custom onPress, file
    // navigation, or (the common case) inline expansion.
    const canExpandInline = !onPress && !filePath;
    const isPressable = !!(onPress || (sessionId && filePath) || canExpandInline);

    let knownTool = knownTools[tool.name as keyof typeof knownTools] as any;

    // Internal Claude Code tools (e.g. ToolSearch) are completely hidden from the UI
    if (knownTool?.hidden) {
        return null;
    }

    let description: string | null = null;
    let status: string | null = null;
    let minimal = false;
    let icon = <Ionicons name="construct-outline" size={18} color={theme.colors.textSecondary} />;
    let noStatus = false;
    let hideDefaultError = false;
    
    // For Gemini: unknown tools should be rendered as minimal (hidden)
    // This prevents showing raw INPUT/OUTPUT for internal Gemini tools
    // that we haven't explicitly added to knownTools
    const isGemini = props.metadata?.flavor === 'gemini';
    if (!knownTool && isGemini) {
        minimal = true;
    }

    // Extract status first to potentially use as title
    if (knownTool && typeof knownTool.extractStatus === 'function') {
        const state = knownTool.extractStatus({ tool, metadata: props.metadata });
        if (typeof state === 'string' && state) {
            status = state;
        }
    }

    // Handle optional title and function type
    let toolTitle = tool.name;
    
    // Special handling for MCP tools
    if (tool.name.startsWith('mcp__')) {
        toolTitle = formatMCPTitle(tool.name);
        icon = <Ionicons name="extension-puzzle-outline" size={18} color={theme.colors.textSecondary} />;
        minimal = true;
    } else if (knownTool?.title) {
        if (typeof knownTool.title === 'function') {
            toolTitle = knownTool.title({ tool, metadata: props.metadata });
        } else {
            toolTitle = knownTool.title;
        }
    }

    if (knownTool && typeof knownTool.extractSubtitle === 'function') {
        const subtitle = knownTool.extractSubtitle({ tool, metadata: props.metadata });
        if (typeof subtitle === 'string' && subtitle) {
            description = subtitle;
        }
    }
    if (knownTool && knownTool.minimal !== undefined) {
        if (typeof knownTool.minimal === 'function') {
            minimal = knownTool.minimal({ tool, metadata: props.metadata, messages: props.messages });
        } else {
            minimal = knownTool.minimal;
        }
    }
    
    // Special handling for CodexBash to determine icon based on parsed_cmd
    if (tool.name === 'CodexBash' && tool.input?.parsed_cmd && Array.isArray(tool.input.parsed_cmd) && tool.input.parsed_cmd.length > 0) {
        const parsedCmd = tool.input.parsed_cmd[0];
        if (parsedCmd.type === 'read') {
            icon = <Octicons name="eye" size={18} color={theme.colors.text} />;
        } else if (parsedCmd.type === 'write') {
            icon = <Octicons name="file-diff" size={18} color={theme.colors.text} />;
        } else {
            icon = <Octicons name="terminal" size={18} color={theme.colors.text} />;
        }
    } else if (knownTool && typeof knownTool.icon === 'function') {
        icon = knownTool.icon(18, theme.colors.text);
    }
    
    if (knownTool && typeof knownTool.noStatus === 'boolean') {
        noStatus = knownTool.noStatus;
    }
    if (knownTool && typeof knownTool.hideDefaultError === 'boolean') {
        hideDefaultError = knownTool.hideDefaultError;
    }

    let statusIcon = null;

    let isToolUseError = false;
    if (tool.state === 'error' && tool.result && parseToolUseError(tool.result).isToolUseError) {
        isToolUseError = true;
        console.log('isToolUseError', tool.result);
    }

    // Check permission status first for denied/canceled states
    if (tool.permission && (tool.permission.status === 'denied' || tool.permission.status === 'canceled')) {
        statusIcon = <Ionicons name="remove-circle-outline" size={20} color={theme.colors.textSecondary} />;
    } else if (isToolUseError) {
        statusIcon = <Ionicons name="remove-circle-outline" size={20} color={theme.colors.textSecondary} />;
        hideDefaultError = true;
        minimal = true;
    } else {
        switch (tool.state) {
            case 'running':
                if (!noStatus) {
                    statusIcon = <ActivityIndicator size="small" color={theme.colors.text} style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }} />;
                }
                break;
            case 'completed':
                // if (!noStatus) {
                //     statusIcon = <Ionicons name="checkmark-circle" size={20} color="#34C759" />;
                // }
                break;
            case 'error':
                statusIcon = <Ionicons name="alert-circle-outline" size={20} color={theme.colors.warning} />;
                break;
        }
    }

    const terminalCommand = getTerminalToolCommand(tool);
    const isCompactTerminalTool = terminalCommand !== null;
    const isInlineCodexPatch = Platform.OS === 'web' && tool.name === 'CodexPatch';
    const renderCardHeader = shouldRenderToolCardHeader(tool.name, Platform.OS);
    const renderPermissionFooter = () => (
        tool.permission && sessionId && tool.name !== 'AskUserQuestion'
            ? <PermissionFooter permission={tool.permission} sessionId={sessionId} toolName={tool.name} toolInput={tool.input} metadata={props.metadata} />
            : null
    );

    // Total duration for a finished tool: completedAt - (startedAt|createdAt).
    const completedDurationMs = (
        tool.state !== 'running' && tool.completedAt
            ? tool.completedAt - (tool.startedAt ?? tool.createdAt)
            : null
    );
    const showInlineExpandChevron = canExpandInline && !minimal && !isCompactTerminalTool;

    const renderHeaderContent = () => {
        if (isCompactTerminalTool) {
            return (
                <View style={styles.compactHeaderLeft}>
                    <View style={styles.compactIconContainer}>
                        {icon}
                    </View>
                    <Text style={styles.compactToolName} numberOfLines={1}>{toolTitle}</Text>
                    {status ? <Text style={styles.compactStatus} numberOfLines={1}>{status}</Text> : null}
                    <Text style={styles.compactCommandText} numberOfLines={1}>
                        {terminalCommand}
                    </Text>
                    {tool.state === 'running' ? (
                        <View style={styles.elapsedContainer}>
                            <ElapsedView from={tool.createdAt} />
                        </View>
                    ) : completedDurationMs !== null ? (
                        <View style={styles.elapsedContainer}>
                            <Text style={styles.elapsedText}>{formatDurationBadge(completedDurationMs)}</Text>
                        </View>
                    ) : null}
                    {statusIcon}
                </View>
            );
        }

        return (
            <View style={styles.headerLeft}>
                <View style={styles.iconContainer}>
                    {icon}
                </View>
                <View style={styles.titleContainer}>
                    <Text style={styles.toolName} numberOfLines={1}>{toolTitle}{status ? <Text style={styles.status}>{` ${status}`}</Text> : null}</Text>
                    {description && (
                        <Text style={styles.toolDescription} numberOfLines={1}>
                            {description}
                        </Text>
                    )}
                </View>
                {tool.state === 'running' ? (
                    <View style={styles.elapsedContainer}>
                        <ElapsedView from={tool.createdAt} />
                    </View>
                ) : completedDurationMs !== null ? (
                    <View style={styles.elapsedContainer}>
                        <Text style={styles.elapsedText}>{formatDurationBadge(completedDurationMs)}</Text>
                    </View>
                ) : null}
                {statusIcon}
                {showInlineExpandChevron && (
                    <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color={theme.colors.textSecondary}
                        style={styles.expandChevron}
                    />
                )}
            </View>
        );
    };

    return (
        <Animated.View
            layout={LinearTransition.duration(200)}
            style={isCompactTerminalTool ? styles.compactContainer : isInlineCodexPatch ? styles.inlineContainer : styles.container}
        >
            {renderCardHeader ? (
                isPressable ? (
                    <TouchableOpacity style={isCompactTerminalTool ? styles.compactHeader : styles.header} onPress={handlePress} activeOpacity={0.8}>
                        {renderHeaderContent()}
                    </TouchableOpacity>
                ) : (
                    <View style={isCompactTerminalTool ? styles.compactHeader : styles.header}>
                        {renderHeaderContent()}
                    </View>
                )
            ) : null}

            {/* Content area - either custom children or tool-specific view */}
            {(() => {
                // Check if minimal first - minimal tools don't show content
                if (minimal || isCompactTerminalTool) {
                    return null;
                }

                // Try to use a specific tool view component first
                const SpecificToolView = getToolViewComponent(tool.name);
                if (SpecificToolView) {
                    return (
                        <View style={styles.content}>
                            <SpecificToolView
                                tool={tool}
                                metadata={props.metadata}
                                messages={props.messages ?? []}
                                sessionId={sessionId}
                                permissionFooter={isInlineCodexPatch ? renderPermissionFooter() : undefined}
                            />
                            {tool.state === 'error' && tool.result &&
                                !(tool.permission && (tool.permission.status === 'denied' || tool.permission.status === 'canceled')) &&
                                !hideDefaultError && (
                                    <ToolError message={String(tool.result)} />
                                )}
                        </View>
                    );
                }

                // Show error state if present (but not for denied/canceled permissions and not when hideDefaultError is true)
                if (tool.state === 'error' && tool.result &&
                    !(tool.permission && (tool.permission.status === 'denied' || tool.permission.status === 'canceled')) &&
                    !isToolUseError) {
                    return (
                        <View style={styles.content}>
                            <ToolError message={String(tool.result)} />
                        </View>
                    );
                }

                // For inline-expandable tools, the verbose input/output is
                // owned by the expanded region below — keep the collapsed card
                // clean and avoid duplicating it here.
                if (canExpandInline) {
                    return null;
                }

                // Fall back to default view
                return (
                    <View style={styles.content}>
                        {/* Default content when no custom view available */}
                        {tool.input && (
                            <ToolSectionView title={t('toolView.input')}>
                                <CodeView code={JSON.stringify(tool.input, null, 2)} />
                            </ToolSectionView>
                        )}

                        {tool.state === 'completed' && tool.result && (
                            <ToolSectionView title={t('toolView.output')}>
                                <CodeView
                                    code={typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}
                                />
                            </ToolSectionView>
                        )}
                    </View>
                );
            })()}

            {/* Inline expanded detail — replaces the old full-screen push.
                Renders the raw tool input / output / error in place (the
                specialized summary already shows above), with an escape hatch
                to the full-screen page for deep-linking / sharing. */}
            {canExpandInline && expanded && !isCompactTerminalTool && (
                <Animated.View
                    entering={FadeIn.duration(160)}
                    exiting={FadeOut.duration(120)}
                    style={styles.expandedDetail}
                >
                    {tool.input && (
                        <ToolSectionView title={t('toolView.input')}>
                            <CodeView code={JSON.stringify(tool.input, null, 2)} />
                        </ToolSectionView>
                    )}
                    {tool.result != null && (
                        <ToolSectionView title={t('toolView.output')}>
                            <CodeView
                                code={typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}
                            />
                        </ToolSectionView>
                    )}
                    {sessionId && messageId ? (
                        <Pressable onPress={openFullPage} hitSlop={6} style={styles.openFullPageRow}>
                            <Ionicons name="open-outline" size={14} color={theme.colors.textLink} />
                            <Text style={styles.openFullPageText}>Open full view</Text>
                        </Pressable>
                    ) : null}
                </Animated.View>
            )}

            {/* Permission footer - always renders when permission exists to maintain consistent height */}
            {/* AskUserQuestion has its own Submit button UI - no permission footer needed */}
            {!isInlineCodexPatch ? renderPermissionFooter() : null}
        </Animated.View>
    );
});

function formatDurationBadge(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const totalSeconds = Math.round(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const rem = totalSeconds % 60;
    return `${minutes}m${rem.toString().padStart(2, '0')}s`;
}

function ElapsedView(props: { from: number }) {
    const { from } = props;
    const elapsed = useElapsedTime(from);
    return <Text style={styles.elapsedText}>{elapsed.toFixed(1)}s</Text>;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        marginVertical: 4,
        overflow: 'hidden'
    },
    compactContainer: {
        backgroundColor: 'transparent',
        marginVertical: 1,
        overflow: 'visible',
    },
    inlineContainer: {
        backgroundColor: 'transparent',
        marginVertical: 1,
        overflow: 'visible',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    compactHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 28,
        paddingHorizontal: 4,
        paddingVertical: 3,
        borderRadius: 4,
        backgroundColor: 'transparent',
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    iconContainer: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    compactHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flex: 1,
        minWidth: 0,
    },
    compactIconContainer: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    titleContainer: {
        flex: 1,
    },
    elapsedContainer: {
        marginLeft: 8,
    },
    elapsedText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    toolName: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    compactToolName: {
        fontSize: 13,
        lineHeight: 18,
        fontWeight: '500',
        color: theme.colors.text,
        flexShrink: 0,
        maxWidth: 150,
    },
    compactStatus: {
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        flexShrink: 0,
    },
    compactCommandText: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    status: {
        fontWeight: '400',
        opacity: 0.3,
        fontSize: 15,
    },
    toolDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    content: {
        paddingHorizontal: 12,
        paddingTop: 8,
        overflow: 'visible'
    },
    expandChevron: {
        marginLeft: 4,
    },
    expandedDetail: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        overflow: 'visible',
    },
    openFullPageRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 6,
    },
    openFullPageText: {
        fontSize: 13,
        color: theme.colors.textLink,
        fontWeight: '500',
    },
}));
