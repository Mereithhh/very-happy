import * as React from 'react';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight, useIsTablet } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { sessionUpdateTitle } from '@/sync/ops';
import { t } from '@/text';

interface ChatHeaderViewProps {
    title: string;
    /** Project folder name (last path segment) */
    folderName?: string;
    /** Extra path segment appended to the title with a separator (used for the file-view overlay). */
    extraPathSegment?: string;
    /** Optional content rendered at the right edge of the header (used by file-view / diff overlays). */
    rightSlot?: React.ReactNode;
    onTitlePress?: () => void;
    onBackPress?: () => void;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    /**
     * When set, a rename affordance is shown next to the title. Tapping it
     * opens a prompt and writes the new title directly via the session
     * `update-metadata` op (bypasses the change_title MCP tool).
     */
    sessionId?: string;
    /**
     * The session's current summary text (raw `metadata.summary?.text`), used
     * to prefill the rename input and to drive the "no title" placeholder.
     * Undefined/empty means the session has no title yet.
     */
    summaryText?: string;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    folderName,
    extraPathSegment,
    rightSlot,
    onTitlePress,
    onBackPress,
    isConnected = true,
    sessionId,
    summaryText,
}) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const showBackButton = !isTablet && !!onBackPress;
    const hasExtra = !!extraPathSegment;
    const canRename = !!sessionId && !hasExtra;
    const hasTitle = !!(summaryText && summaryText.trim().length > 0);

    const handleRename = React.useCallback(async () => {
        if (!sessionId) return;
        const next = await Modal.prompt(
            t('session.renameTitle'),
            undefined,
            {
                defaultValue: summaryText ?? '',
                placeholder: t('session.renamePlaceholder'),
                cancelText: t('common.cancel'),
                confirmText: t('common.save'),
            },
        );
        // null = cancelled. Empty string is treated as "no change" here to
        // avoid accidentally clearing the title from the prompt.
        if (next === null) return;
        const trimmed = next.trim();
        if (trimmed.length === 0 || trimmed === (summaryText ?? '').trim()) return;
        try {
            await sessionUpdateTitle(sessionId, trimmed);
        } catch (error) {
            Modal.alert(t('common.error'), String(error instanceof Error ? error.message : error));
        }
    }, [sessionId, summaryText]);

    // When the session has no title yet, surface a tappable "Set title"
    // affordance in place of the (fallback) title text.
    const displayTitle = canRename && !hasTitle ? t('session.setTitle') : title;
    const titlePlaceholderStyle = canRename && !hasTitle
        ? { color: theme.colors.textSecondary }
        : { color: theme.colors.header.tint };

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.header.background }]}>
            <View style={styles.contentWrapper}>
                <View style={[styles.content, { height: headerHeight }]}>
                    {showBackButton && (
                        <Pressable onPress={onBackPress} hitSlop={15} style={styles.backButton}>
                            <Ionicons
                                name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                size={24}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    )}
                    <Pressable
                        style={styles.titleContainer}
                        onPress={onTitlePress}
                        disabled={!onTitlePress}
                    >
                        {folderName ? (
                            <View style={styles.titleRow}>
                                <Text
                                    numberOfLines={1}
                                    style={[styles.folderName, { color: theme.colors.textSecondary, ...Typography.default() }]}
                                >
                                    {folderName}
                                </Text>
                                {(displayTitle && displayTitle !== folderName) && (
                                    <>
                                        <Text style={[styles.separator, { color: theme.colors.textSecondary, ...Typography.default() }]}>/</Text>
                                        <Text
                                            numberOfLines={1}
                                            ellipsizeMode="tail"
                                            style={[
                                                styles.title,
                                                hasExtra && styles.titleWithExtra,
                                                { ...titlePlaceholderStyle, ...Typography.default() },
                                            ]}
                                        >
                                            {displayTitle}
                                        </Text>
                                    </>
                                )}
                                {hasExtra && (
                                    <>
                                        <Text style={[styles.separator, { color: theme.colors.textSecondary, ...Typography.default() }]}>/</Text>
                                        <Text
                                            numberOfLines={1}
                                            ellipsizeMode="middle"
                                            style={[styles.extraPath, { color: theme.colors.header.tint, ...Typography.mono() }]}
                                        >
                                            {extraPathSegment}
                                        </Text>
                                    </>
                                )}
                            </View>
                        ) : (
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={[styles.title, { ...titlePlaceholderStyle, ...Typography.default() }]}
                            >
                                {displayTitle}
                            </Text>
                        )}
                    </Pressable>
                    {canRename && (
                        <Pressable
                            onPress={handleRename}
                            hitSlop={12}
                            style={({ pressed }) => [styles.renameButton, { opacity: pressed ? 0.5 : 1 }]}
                            accessibilityLabel={t('session.renameTitle')}
                            accessibilityRole="button"
                        >
                            <Ionicons
                                name="pencil"
                                size={16}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    )}
                    {rightSlot ? (
                        <View style={styles.rightSlot}>
                            {rightSlot}
                        </View>
                    ) : null}
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.OS === 'ios' ? 8 : 16,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        width: '100%',
    },
    folderName: {
        fontSize: 14,
        flexShrink: 0,
    },
    separator: {
        fontSize: 14,
        flexShrink: 0,
    },
    title: {
        fontSize: 14,
        fontWeight: '600',
        flexShrink: 1,
    },
    titleWithExtra: {
        // When an extra path segment follows, let the chat name keep its
        // intrinsic width and squeeze the path first.
        flexShrink: 0.5,
    },
    extraPath: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        flexShrink: 1,
    },
    rightSlot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginLeft: 12,
        flexShrink: 0,
    },
    backButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    renameButton: {
        paddingHorizontal: 6,
        paddingVertical: 4,
        marginLeft: 4,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
