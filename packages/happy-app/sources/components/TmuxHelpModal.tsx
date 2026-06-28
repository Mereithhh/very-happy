/**
 * tmux cheat-sheet shown from the web terminal header's "?" button. Our vh-
 * sessions run with `mouse on`, so the first thing people need is "the wheel
 * scrolls", then the prefix-key basics. Console look, bilingual, scrollable so
 * it fits a phone. Shown via `Modal.show({ component: TmuxHelpModal })`.
 */
import * as React from 'react';
import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

interface Shortcut {
    keys: string;
    label: string;
}

interface Section {
    title: string;
    note?: string;
    items: Shortcut[];
}

function buildSections(): Section[] {
    return [
        {
            title: t('tmuxHelp.mouse'),
            items: [
                { keys: t('tmuxHelp.keyWheel'), label: t('tmuxHelp.labelWheel') },
                { keys: t('tmuxHelp.keyClick'), label: t('tmuxHelp.labelClick') },
                { keys: t('tmuxHelp.keyShiftDrag'), label: t('tmuxHelp.labelShiftDrag') },
            ],
        },
        {
            title: t('tmuxHelp.prefix'),
            note: t('tmuxHelp.prefixNote'),
            items: [
                { keys: 'Ctrl-b', label: t('tmuxHelp.labelPrefix') },
            ],
        },
        {
            title: t('tmuxHelp.scrollback'),
            items: [
                { keys: 'Ctrl-b  [', label: t('tmuxHelp.labelEnterCopy') },
                { keys: '↑ ↓  PgUp', label: t('tmuxHelp.labelScroll') },
                { keys: 'q', label: t('tmuxHelp.labelQuit') },
            ],
        },
        {
            title: t('tmuxHelp.panes'),
            items: [
                { keys: 'Ctrl-b  %', label: t('tmuxHelp.labelSplitV') },
                { keys: 'Ctrl-b  "', label: t('tmuxHelp.labelSplitH') },
                { keys: 'Ctrl-b  ←↑↓→', label: t('tmuxHelp.labelMovePanes') },
                { keys: 'Ctrl-b  z', label: t('tmuxHelp.labelZoom') },
                { keys: 'Ctrl-b  x', label: t('tmuxHelp.labelClosePane') },
            ],
        },
        {
            title: t('tmuxHelp.windows'),
            items: [
                { keys: 'Ctrl-b  c', label: t('tmuxHelp.labelNewWindow') },
                { keys: 'Ctrl-b  n / p', label: t('tmuxHelp.labelNextPrev') },
                { keys: 'Ctrl-b  0–9', label: t('tmuxHelp.labelJump') },
            ],
        },
        {
            title: t('tmuxHelp.session'),
            items: [
                { keys: 'Ctrl-b  d', label: t('tmuxHelp.labelDetach') },
            ],
        },
    ];
}

interface TmuxHelpModalProps {
    onClose?: () => void;
}

function KeyChip({ value }: { value: string }) {
    const { theme } = useUnistyles();
    return (
        <View style={[styles.chip, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
            <Text style={[styles.chipText, { color: theme.colors.textLink, ...Typography.mono('semiBold') }]}>{value}</Text>
        </View>
    );
}

export function TmuxHelpModal(_props: TmuxHelpModalProps) {
    const { theme } = useUnistyles();
    const sections = buildSections();
    return (
        <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.eyebrow, { color: theme.colors.textLink, ...Typography.mono() }]}>TMUX</Text>
            <Text style={[styles.heading, { color: theme.colors.text, ...Typography.default('semiBold') }]}>{t('tmuxHelp.heading')}</Text>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody} showsVerticalScrollIndicator={false}>
                {sections.map((section) => (
                    <View key={section.title} style={styles.section}>
                        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary, ...Typography.mono('semiBold') }]}>
                            {section.title}
                        </Text>
                        {section.note && (
                            <Text style={[styles.note, { color: theme.colors.textSecondary, ...Typography.default() }]}>{section.note}</Text>
                        )}
                        {section.items.map((item, i) => (
                            <View key={i} style={styles.row}>
                                <KeyChip value={item.keys} />
                                <Text style={[styles.label, { color: theme.colors.text, ...Typography.default() }]}>{item.label}</Text>
                            </View>
                        ))}
                    </View>
                ))}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        width: '100%',
        maxWidth: 460,
        borderRadius: 16,
        padding: 20,
        maxHeight: Platform.OS === 'web' ? ('80vh' as any) : '85%',
    },
    eyebrow: {
        fontSize: 11,
        letterSpacing: 2,
        marginBottom: 6,
    },
    heading: {
        fontSize: 20,
        marginBottom: 12,
    },
    scroll: {
        flexGrow: 0,
    },
    scrollBody: {
        paddingBottom: 4,
    },
    section: {
        marginBottom: 16,
    },
    sectionTitle: {
        fontSize: 11,
        letterSpacing: 1,
        textTransform: 'uppercase',
        marginBottom: 8,
    },
    note: {
        fontSize: 12,
        lineHeight: 17,
        marginBottom: 8,
        opacity: 0.9,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 8,
    },
    chip: {
        borderWidth: 1,
        borderRadius: 7,
        paddingHorizontal: 8,
        paddingVertical: 4,
        minWidth: 96,
        alignItems: 'center',
    },
    chipText: {
        fontSize: 12,
    },
    label: {
        flex: 1,
        fontSize: 13,
        lineHeight: 19,
        paddingTop: 3,
    },
});
