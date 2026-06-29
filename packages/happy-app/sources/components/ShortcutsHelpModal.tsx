/**
 * Console-style keyboard shortcuts cheat sheet (web). Shown via
 * `Modal.show({ component: ShortcutsHelpModal })` from the global shortcut
 * handler (`?` or ⌘/). Each row is a mono key chip + a localized description.
 */
import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

interface ShortcutsHelpModalProps {
    onClose?: () => void;
}

interface ShortcutRow {
    keys: string[];
    label: string;
}

function KeyChip({ label }: { label: string }) {
    const { theme } = useUnistyles();
    return (
        <View
            style={[
                styles.chip,
                { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider },
            ]}
        >
            <Text style={[styles.chipText, { color: theme.colors.textLink, ...Typography.mono('semiBold') }]}>
                {label}
            </Text>
        </View>
    );
}

export function ShortcutsHelpModal({ onClose }: ShortcutsHelpModalProps) {
    const { theme } = useUnistyles();

    const rows = React.useMemo<ShortcutRow[]>(() => [
        { keys: ['⌘', 'K'], label: t('shortcuts.search') },
        { keys: ['⌘', '1–9'], label: t('shortcuts.switchSession') },
        { keys: ['⌘', 'R'], label: t('shortcuts.renameSession') },
        { keys: ['Esc'], label: t('shortcuts.goBack') },
        { keys: ['?'], label: t('shortcuts.showHelp') },
    ], []);

    return (
        <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.eyebrow, { color: theme.colors.textLink, ...Typography.mono() }]}>
                {t('shortcuts.eyebrow')}
            </Text>
            <Text style={[styles.heading, { color: theme.colors.text, ...Typography.default('semiBold') }]}>
                {t('shortcuts.title')}
            </Text>
            <View style={styles.rows}>
                {rows.map((row) => (
                    <View key={row.label} style={styles.row}>
                        <View style={styles.keys}>
                            {row.keys.map((k, i) => (
                                <KeyChip key={`${row.label}-${i}`} label={k} />
                            ))}
                        </View>
                        <Text
                            style={[styles.rowLabel, { color: theme.colors.text, ...Typography.default() }]}
                            numberOfLines={2}
                        >
                            {row.label}
                        </Text>
                    </View>
                ))}
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
    rows: {
        gap: 12,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
    },
    keys: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        width: 96,
        flexShrink: 0,
    },
    chip: {
        minWidth: 24,
        height: 24,
        paddingHorizontal: 6,
        borderRadius: 6,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chipText: {
        fontSize: 12,
    },
    rowLabel: {
        flex: 1,
        fontSize: 14,
    },
});
