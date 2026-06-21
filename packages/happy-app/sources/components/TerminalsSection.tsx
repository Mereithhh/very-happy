/**
 * Sidebar "Terminals" group (web only). Lists the device's persisted terminal
 * sessions; tap to (re)attach, ⋯ to rename or remove. Pinned above the
 * conversation list so terminals are managed alongside chats.
 */
import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { machineKillTerminal } from '@/sync/ops';

const stylesheet = StyleSheet.create((theme) => ({
    header: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        letterSpacing: 0.6,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        paddingHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 12,
        // Match the conversation rows: flat, hairline-separated, transparent
        // left edge so an active terminal can light it teal without a shift.
        borderLeftWidth: 3,
        borderLeftColor: 'transparent',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    rowPressed: { backgroundColor: theme.colors.surfaceSelected },
    title: { ...Typography.default(), fontSize: 14, color: theme.colors.text, flex: 1 },
    kebab: { padding: 4, borderRadius: 6 },
}));

export function TerminalsSection() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const terminals = useTerminalSessions((s) => s.terminals);
    const rename = useTerminalSessions((s) => s.rename);
    const remove = useTerminalSessions((s) => s.remove);

    if (Platform.OS !== 'web' || terminals.length === 0) return null;

    const open = (machineId: string, id: string) => {
        router.push(`/terminal/web/${machineId}?tid=${id}` as any);
    };

    const menu = (id: string, machineId: string, title: string) => {
        Modal.alert(title, undefined, [
            {
                text: t('common.rename'),
                onPress: async () => {
                    const next = await Modal.prompt(t('common.rename'), undefined, { defaultValue: title });
                    if (next && next.trim()) rename(id, next.trim());
                },
            },
            {
                text: t('common.delete'),
                style: 'destructive',
                onPress: () => {
                    remove(id);
                    void machineKillTerminal(machineId, id);
                },
            },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    };

    return (
        <View>
            <Text style={styles.header}>Terminals</Text>
            {terminals.map((term) => (
                <Pressable
                    key={term.id}
                    onPress={() => open(term.machineId, term.id)}
                    onLongPress={() => menu(term.id, term.machineId, term.title)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                    <Ionicons name="terminal-outline" size={16} color={theme.colors.textSecondary} />
                    <Text style={styles.title} numberOfLines={1}>{term.title}</Text>
                    <Pressable hitSlop={8} style={styles.kebab} onPress={() => menu(term.id, term.machineId, term.title)}>
                        <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                </Pressable>
            ))}
        </View>
    );
}
