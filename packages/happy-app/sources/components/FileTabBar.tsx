/**
 * Horizontal, scrollable tab bar for the desktop multi-file viewer.
 *
 * Renders one chip per open file (from the per-session fileTabs store). The
 * active tab is highlighted; each tab has a close affordance. The whole strip
 * scrolls horizontally so it degrades gracefully on narrower windows.
 */
import * as React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { FileTab } from '@/-session/fileTabs';

interface FileTabBarProps {
    tabs: FileTab[];
    activePath: string | null;
    onSelect: (path: string) => void;
    onClose: (path: string) => void;
}

export const FileTabBar = React.memo(function FileTabBar({
    tabs,
    activePath,
    onSelect,
    onClose,
}: FileTabBarProps) {
    const { theme } = useUnistyles();
    if (tabs.length === 0) return null;

    return (
        <View style={[styles.bar, { backgroundColor: theme.colors.surfaceHigh, borderBottomColor: theme.colors.divider }]}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.scrollContent}
            >
                {tabs.map((tab) => {
                    const isActive = tab.path === activePath;
                    return (
                        <Pressable
                            key={tab.path}
                            onPress={() => onSelect(tab.path)}
                            style={({ pressed }) => [
                                styles.tab,
                                {
                                    backgroundColor: isActive ? theme.colors.surface : 'transparent',
                                    borderColor: isActive ? theme.colors.divider : 'transparent',
                                },
                                pressed && !isActive && { backgroundColor: theme.colors.surfaceSelected },
                            ]}
                        >
                            <FileIcon fileName={tab.name} size={14} />
                            <Text
                                style={[
                                    styles.tabLabel,
                                    { color: isActive ? theme.colors.text : theme.colors.textSecondary },
                                ]}
                                numberOfLines={1}
                            >
                                {tab.name}
                            </Text>
                            <Pressable
                                onPress={() => onClose(tab.path)}
                                hitSlop={8}
                                style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
                            >
                                <Ionicons name="close" size={13} color={theme.colors.textSecondary} />
                            </Pressable>
                        </Pressable>
                    );
                })}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    bar: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    scrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        maxWidth: 200,
        paddingLeft: 10,
        paddingRight: 6,
        paddingVertical: 5,
        borderRadius: 7,
        borderWidth: StyleSheet.hairlineWidth,
    },
    tabLabel: {
        fontSize: 12,
        maxWidth: 130,
        ...Typography.default(),
    },
    closeBtn: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
    },
}));
