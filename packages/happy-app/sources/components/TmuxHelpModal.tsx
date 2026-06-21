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

interface Shortcut {
    keys: string;
    label: string;
}

interface Section {
    title: string;
    note?: string;
    items: Shortcut[];
}

const SECTIONS: Section[] = [
    {
        title: '鼠标 · Mouse',
        items: [
            { keys: '滚轮', label: '上下滚动回看历史 / Wheel scrolls history' },
            { keys: '点击', label: '切换窗格、窗口 / Click panes & windows' },
            { keys: 'Shift+拖动', label: '用浏览器选中复制（绕过 tmux）/ Select to copy' },
        ],
    },
    {
        title: '前缀键 · Prefix',
        note: '先按 Ctrl-b 松开，再按下面的键 / Press Ctrl-b, release, then the key',
        items: [
            { keys: 'Ctrl-b', label: '所有 tmux 快捷键的前缀 / Prefix for every command' },
        ],
    },
    {
        title: '回看 · Scrollback',
        items: [
            { keys: 'Ctrl-b  [', label: '进入回看模式 / Enter copy mode' },
            { keys: '↑ ↓  PgUp', label: '在回看里滚动 / Scroll' },
            { keys: 'q', label: '退出回看 / Quit copy mode' },
        ],
    },
    {
        title: '窗格 · Panes',
        items: [
            { keys: 'Ctrl-b  %', label: '竖向分屏 / Split vertically' },
            { keys: 'Ctrl-b  "', label: '横向分屏 / Split horizontally' },
            { keys: 'Ctrl-b  ←↑↓→', label: '在窗格间切换 / Move between panes' },
            { keys: 'Ctrl-b  z', label: '当前窗格全屏切换 / Zoom toggle' },
            { keys: 'Ctrl-b  x', label: '关闭当前窗格 / Close pane' },
        ],
    },
    {
        title: '窗口 · Windows',
        items: [
            { keys: 'Ctrl-b  c', label: '新建窗口 / New window' },
            { keys: 'Ctrl-b  n / p', label: '下一个 / 上一个 / Next / prev' },
            { keys: 'Ctrl-b  0–9', label: '按编号跳转 / Jump by number' },
        ],
    },
    {
        title: '会话 · Session',
        items: [
            { keys: 'Ctrl-b  d', label: '脱离会话（仍在后台运行，可随时重连）/ Detach — keeps running' },
        ],
    },
];

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
    return (
        <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.eyebrow, { color: theme.colors.textLink, ...Typography.mono() }]}>TMUX</Text>
            <Text style={[styles.heading, { color: theme.colors.text, ...Typography.default('semiBold') }]}>快捷键 · Shortcuts</Text>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody} showsVerticalScrollIndicator={false}>
                {SECTIONS.map((section) => (
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
