/**
 * Web terminal — machine picker. Lists the account's machines and opens a web
 * terminal on the chosen one. (Machines are already account-scoped, so this
 * only ever shows the user's own machines.)
 */
import * as React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';

const stylesheet = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.groupped.background },
    content: { padding: 16, maxWidth: 640, width: '100%', alignSelf: 'center', gap: 10 },
    intro: { ...Typography.default(), fontSize: 14, color: theme.colors.textSecondary, marginBottom: 6, marginTop: 4 },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        backgroundColor: theme.colors.surface, borderRadius: 12, padding: 16,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
    },
    rowDisabled: { opacity: 0.5 },
    name: { ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.text },
    sub: { ...Typography.default(), fontSize: 12, color: theme.colors.textSecondary, marginTop: 2 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    empty: { ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center', marginTop: 48, paddingHorizontal: 32 },
}));

export default function WebTerminalPicker() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines();

    const sorted = React.useMemo(() => {
        return [...machines].sort((a, b) => Number(isMachineOnline(b)) - Number(isMachineOnline(a)));
    }, [machines]);

    if (machines.length === 0) {
        return (
            <View style={styles.container}>
                <Text style={styles.empty}>No machines yet. Run `very-happy` on a computer to connect one, then open a terminal here.</Text>
            </View>
        );
    }

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            <Text style={styles.intro}>Open a terminal on one of your machines.</Text>
            {sorted.map((m) => {
                const online = isMachineOnline(m);
                const name = m.metadata?.displayName || m.metadata?.host || m.id;
                const platform = m.metadata?.platform || '';
                return (
                    <Pressable
                        key={m.id}
                        disabled={!online}
                        onPress={() => router.push(`/terminal/web/${m.id}` as any)}
                        style={({ pressed }) => [styles.row, !online && styles.rowDisabled, { opacity: pressed ? 0.8 : (online ? 1 : 0.5) }]}
                    >
                        <View style={[styles.dot, { backgroundColor: online ? theme.colors.status?.connected ?? '#34C759' : theme.colors.textSecondary }]} />
                        <View style={{ flex: 1 }}>
                            <Text style={styles.name}>{name}</Text>
                            <Text style={styles.sub}>{online ? 'Online' : 'Offline'}{platform ? ` · ${platform}` : ''}</Text>
                        </View>
                        <Ionicons name="terminal-outline" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                );
            })}
        </ScrollView>
    );
}
