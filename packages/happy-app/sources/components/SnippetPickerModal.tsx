/**
 * Pick a saved snippet to insert — prompt presets into the chat composer, or
 * quick commands into the web terminal. Shown via `Modal.show`; the caller
 * passes the items and an onPick that does the insertion. Empty state points
 * the user at Settings → Snippets.
 */
import * as React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export interface SnippetPickItem {
    id: string;
    title: string;
    body: string;
}

interface SnippetPickerModalProps {
    heading: string;
    items: SnippetPickItem[];
    bodyMono?: boolean;
    emptyHint: string;
    onPick: (body: string) => void;
    onClose?: () => void;
}

export function SnippetPickerModal({ heading, items, bodyMono, emptyHint, onPick, onClose }: SnippetPickerModalProps) {
    const { theme } = useUnistyles();
    const router = useRouter();

    return (
        <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.heading, { color: theme.colors.text, ...Typography.default('semiBold') }]}>{heading}</Text>

            {items.length === 0 ? (
                <View style={styles.empty}>
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary, ...Typography.default() }]}>{emptyHint}</Text>
                    <Pressable
                        onPress={() => { onClose?.(); router.push('/settings/snippets' as any); }}
                        style={[styles.manageBtn, { borderColor: theme.colors.divider }]}
                    >
                        <Ionicons name="settings-outline" size={15} color={theme.colors.textSecondary} />
                        <Text style={[styles.manageText, { color: theme.colors.textSecondary, ...Typography.default() }]}>去设置添加 · Manage</Text>
                    </Pressable>
                </View>
            ) : (
                <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 4 }} showsVerticalScrollIndicator={false}>
                    {items.map((item) => (
                        <Pressable
                            key={item.id}
                            onPress={() => { onPick(item.body); onClose?.(); }}
                            style={({ pressed, hovered }: any) => [
                                styles.row,
                                { borderColor: theme.colors.divider, backgroundColor: pressed || hovered ? theme.colors.surfaceSelected : theme.colors.surfaceHigh },
                            ]}
                        >
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={[styles.rowTitle, { color: theme.colors.text, ...Typography.default('semiBold') }]} numberOfLines={1}>{item.title}</Text>
                                <Text style={[styles.rowBody, { color: theme.colors.textSecondary, ...(bodyMono ? Typography.mono() : Typography.default()) }]} numberOfLines={2}>{item.body}</Text>
                            </View>
                            <Ionicons name="arrow-forward" size={16} color={theme.colors.groupped.chevron} />
                        </Pressable>
                    ))}
                </ScrollView>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    card: { width: '100%', maxWidth: 460, borderRadius: 16, padding: 20, maxHeight: 520 },
    heading: { fontSize: 18, marginBottom: 12 },
    scroll: { flexGrow: 0 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 8,
    },
    rowTitle: { fontSize: 15, marginBottom: 2 },
    rowBody: { fontSize: 12, lineHeight: 16 },
    empty: { alignItems: 'center', paddingVertical: 24, gap: 14 },
    emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
    manageBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
    manageText: { fontSize: 13 },
});
