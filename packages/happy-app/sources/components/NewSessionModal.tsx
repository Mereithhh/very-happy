/**
 * Branded "new session" chooser (replaces the bare OS-style Modal.alert).
 * Two option cards — a new agent conversation, or a web terminal — in the
 * Console look. Shown via `Modal.show({ component: NewSessionModal })`, so it
 * receives `onClose` automatically and works identically on desktop + mobile.
 */
import * as React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

interface NewSessionModalProps {
    onClose?: () => void;
}

interface OptionProps {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    subtitle: string;
    onPress: () => void;
}

function Option({ icon, title, subtitle, onPress }: OptionProps) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed, hovered }: any) => [
                styles.option,
                {
                    backgroundColor: pressed || hovered ? theme.colors.surfaceSelected : theme.colors.surfaceHigh,
                    borderColor: theme.colors.divider,
                },
            ]}
        >
            <View style={[styles.iconTile, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
                <Ionicons name={icon} size={20} color={theme.colors.textLink} />
            </View>
            <View style={styles.optionBody}>
                <Text style={[styles.optionTitle, { color: theme.colors.text, ...Typography.default('semiBold') }]}>{title}</Text>
                <Text style={[styles.optionSubtitle, { color: theme.colors.textSecondary, ...Typography.default() }]} numberOfLines={2}>{subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.groupped.chevron} />
        </Pressable>
    );
}

export function NewSessionModal({ onClose }: NewSessionModalProps) {
    const { theme } = useUnistyles();
    const router = useRouter();

    const go = React.useCallback((path: string) => {
        onClose?.();
        router.navigate(path as any);
    }, [onClose, router]);

    return (
        <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.eyebrow, { color: theme.colors.textLink, ...Typography.mono() }]}>NEW SESSION</Text>
            <Text style={[styles.heading, { color: theme.colors.text, ...Typography.default('semiBold') }]}>开始点什么</Text>
            <View style={styles.options}>
                <Option
                    icon="chatbubbles-outline"
                    title="新会话"
                    subtitle="在某台机器上让 Claude / Codex 开始干活"
                    onPress={() => go('/new')}
                />
                {Platform.OS === 'web' && (
                    <Option
                        icon="terminal-outline"
                        title="网页终端"
                        subtitle="在已连接的机器上打开一个终端（tmux）"
                        onPress={() => go('/terminal/web')}
                    />
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        width: '100%',
        maxWidth: 420,
        borderRadius: 16,
        padding: 20,
    },
    eyebrow: {
        fontSize: 11,
        letterSpacing: 2,
        marginBottom: 6,
    },
    heading: {
        fontSize: 20,
        marginBottom: 16,
    },
    options: {
        gap: 10,
    },
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
    },
    iconTile: {
        width: 40,
        height: 40,
        borderRadius: 10,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    optionBody: {
        flex: 1,
        minWidth: 0,
    },
    optionTitle: {
        fontSize: 15,
        marginBottom: 2,
    },
    optionSubtitle: {
        fontSize: 12,
        lineHeight: 16,
    },
});
