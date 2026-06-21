/**
 * Sidebar "Terminals" group (web only). Lists the LIVE tmux terminals reported
 * by each connected machine (cross-device source of truth — see
 * useMachineTerminals), not a per-device cache. Tap to (re)attach, ⋯ to rename
 * (persisted on the machine) or kill the session.
 */
import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useMachineTerminals } from '@/hooks/useMachineTerminals';
import { machineKillTerminal, machineSetTerminalTitle, type MachineTerminal } from '@/sync/ops';

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
        borderLeftWidth: 3,
        borderLeftColor: 'transparent',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    rowPressed: { backgroundColor: theme.colors.surfaceSelected },
    title: { ...Typography.mono(), fontSize: 13, color: theme.colors.text },
    sub: { ...Typography.mono(), fontSize: 11, color: theme.colors.textSecondary, marginTop: 1 },
    kebab: { padding: 4, borderRadius: 6 },
}));

function titleFor(term: MachineTerminal): string {
    if (term.title && term.title.trim()) return term.title.trim();
    if (term.cwd) {
        const segs = term.cwd.replace(/\\/g, '/').split('/').filter(Boolean);
        if (segs.length) return segs[segs.length - 1];
    }
    return term.id;
}

export function TerminalsSection() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const groups = useMachineTerminals();
    // Optimistically hide a terminal the moment it's deleted, so the row
    // disappears instantly instead of lingering until the next poll.
    const [removed, setRemoved] = React.useState<Set<string>>(() => new Set());

    if (Platform.OS !== 'web') return null;

    const multiMachine = groups.length > 1;
    const items = groups.flatMap((g) =>
        g.terminals
            .filter((term) => !removed.has(`${g.machineId}:${term.id}`))
            .map((term) => ({ machineId: g.machineId, machineName: g.machineName, term })),
    );
    if (items.length === 0) return null;

    const open = (machineId: string, id: string) => router.push(`/terminal/web/${machineId}?tid=${id}` as any);

    const menu = (machineId: string, id: string, title: string) => {
        Modal.alert(title, undefined, [
            {
                text: t('common.rename'),
                onPress: async () => {
                    const next = await Modal.prompt(t('common.rename'), undefined, { defaultValue: title });
                    if (next && next.trim()) void machineSetTerminalTitle(machineId, id, next.trim());
                },
            },
            {
                text: t('common.delete'),
                style: 'destructive',
                onPress: () => {
                    setRemoved((prev) => new Set(prev).add(`${machineId}:${id}`));
                    void machineKillTerminal(machineId, id);
                },
            },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    };

    return (
        <View>
            <Text style={styles.header}>Terminals</Text>
            {items.map(({ machineId, machineName, term }) => {
                const title = titleFor(term);
                return (
                    <Pressable
                        key={`${machineId}:${term.id}`}
                        onPress={() => open(machineId, term.id)}
                        onLongPress={() => menu(machineId, term.id, title)}
                        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    >
                        <Ionicons name="terminal-outline" size={16} color={theme.colors.textSecondary} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.title} numberOfLines={1}>{title}</Text>
                            {multiMachine && <Text style={styles.sub} numberOfLines={1}>{machineName}</Text>}
                        </View>
                        <Pressable hitSlop={8} style={styles.kebab} onPress={() => menu(machineId, term.id, title)}>
                            <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
                        </Pressable>
                    </Pressable>
                );
            })}
        </View>
    );
}
