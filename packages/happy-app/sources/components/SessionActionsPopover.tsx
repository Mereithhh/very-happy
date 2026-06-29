import * as React from 'react';
import { Pressable, Modal as RNModal, Platform, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { useSession } from '@/sync/storage';

// A single row in the generic dropdown. Shared by the session quick-actions
// popover and the terminal row menu so both render the exact same affordance.
export interface PopoverActionItem {
    id: string;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

export type SessionActionsAnchor =
    | {
        type: 'point';
        x: number;
        y: number;
    }
    | {
        type: 'rect';
        x: number;
        y: number;
        width: number;
        height: number;
    };

interface SessionActionsPopoverProps {
    anchor: SessionActionsAnchor | null;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onClose: () => void;
    sessionId: string;
    visible: boolean;
}


const WEB_MENU_WIDTH = 232;
const WEB_MENU_ITEM_HEIGHT = 48;
const WEB_MENU_MARGIN = 12;

const stylesheet = StyleSheet.create((theme) => ({
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.12)',
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
        shadowOffset: {
            width: 0,
            height: 8,
        },
        elevation: 10,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 999,
        marginTop: 10,
        marginBottom: 8,
        alignSelf: 'center',
    },
    menuItem: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
    },
    menuItemPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    menuItemDivider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    menuItemLabel: {
        flex: 1,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default(),
    },
    nativeContainer: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    nativeSheet: {
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        overflow: 'hidden',
    },
    webContainer: {
        flex: 1,
    },
    webMenu: {
        position: 'absolute',
        width: WEB_MENU_WIDTH,
    },
}));

// Generic anchored dropdown/action-sheet. Owns positioning, the backdrop, and
// the platform split (web = anchored popover, native = bottom sheet). Both the
// session quick-actions menu and the terminal row menu render through this so
// the ⋯ interaction is identical everywhere.
export function ActionsPopover({
    anchor,
    actions,
    onClose,
    visible,
}: {
    anchor: SessionActionsAnchor | null;
    actions: PopoverActionItem[];
    onClose: () => void;
    visible: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();

    const position = React.useMemo(() => {
        if (!anchor) {
            return null;
        }

        const estimatedHeight = actions.length * WEB_MENU_ITEM_HEIGHT;
        const leftBase = anchor.type === 'point'
            ? anchor.x
            : anchor.x + anchor.width - WEB_MENU_WIDTH;

        let topBase = anchor.type === 'point'
            ? anchor.y
            : anchor.y + anchor.height + 8;

        if (anchor.type === 'rect' && topBase + estimatedHeight > windowHeight - WEB_MENU_MARGIN) {
            topBase = anchor.y - estimatedHeight - 8;
        }

        return {
            left: Math.max(WEB_MENU_MARGIN, Math.min(windowWidth - WEB_MENU_WIDTH - WEB_MENU_MARGIN, leftBase)),
            top: Math.max(WEB_MENU_MARGIN, Math.min(windowHeight - estimatedHeight - WEB_MENU_MARGIN, topBase)),
        };
    }, [actions.length, anchor, windowHeight, windowWidth]);

    const handleActionPress = React.useCallback((action: PopoverActionItem) => {
        onClose();
        action.onPress();
    }, [onClose]);

    if (!visible || !anchor) {
        return null;
    }

    const content = (
        <View style={[styles.card, { backgroundColor: theme.colors.header.background }]}>
            {Platform.OS !== 'web' && (
                <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />
            )}
            {actions.map((action, index) => {
                const isLast = index === actions.length - 1;
                const color = action.destructive ? theme.colors.status.error : theme.colors.text;

                return (
                    <Pressable
                        key={action.id}
                        accessibilityRole="button"
                        onPress={() => handleActionPress(action)}
                        style={({ pressed }) => [
                            styles.menuItem,
                            !isLast && styles.menuItemDivider,
                            pressed && styles.menuItemPressed,
                        ]}
                    >
                        <Ionicons
                            color={color}
                            name={action.icon as keyof typeof Ionicons.glyphMap}
                            size={18}
                        />
                        <Text numberOfLines={1} style={[styles.menuItemLabel, { color }]}>
                            {action.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );

    if (Platform.OS === 'web' && position) {
        return (
            <RNModal
                animationType="none"
                onRequestClose={onClose}
                transparent
                visible={visible}
            >
                <View style={styles.webContainer}>
                    <Pressable onPress={onClose} style={styles.backdrop} />
                    <View
                        style={[
                            styles.webMenu,
                            {
                                left: position.left,
                                top: position.top,
                            },
                        ]}
                    >
                        {content}
                    </View>
                </View>
            </RNModal>
        );
    }

    return (
        <RNModal
            animationType="fade"
            onRequestClose={onClose}
            transparent
            visible={visible}
        >
            <View style={styles.nativeContainer}>
                <Pressable onPress={onClose} style={styles.backdrop} />
                <View
                    style={[
                        styles.nativeSheet,
                        {
                            backgroundColor: theme.colors.header.background,
                            paddingBottom: Math.max(16, safeArea.bottom),
                        },
                    ]}
                >
                    {content}
                </View>
            </View>
        </RNModal>
    );
}

export function SessionActionsPopover({
    anchor,
    onAfterArchive,
    onAfterDelete,
    onClose,
    sessionId,
    visible,
}: SessionActionsPopoverProps) {
    const session = useSession(sessionId);
    const { actionItems: actions } = useSessionQuickActions(session!, {
        onAfterArchive,
        onAfterDelete,
    });

    if (!session) {
        return null;
    }

    return (
        <ActionsPopover
            anchor={anchor}
            actions={actions}
            onClose={onClose}
            visible={visible}
        />
    );
}
