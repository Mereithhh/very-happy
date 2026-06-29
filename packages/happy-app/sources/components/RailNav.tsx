/**
 * RailNav — the leftmost 52px vertical icon rail of the desktop shell
 * (Console v2: rail | sidebar | main).
 *
 * Web/desktop only — returns null on native (mobile uses the bottom TabBar).
 * It carries the brand mark (go home), top-level destination icons (sessions /
 * inbox / terminal) and a bottom settings icon. The inbox icon shows an unread
 * badge driven by the decrypted notification feed.
 */

import * as React from 'react';
import { View, Pressable, Text, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';
import { useNotificationFeed } from '@/sync/useNotificationFeed';
import { DEFAULT_APP_ZOOM } from '@/hooks/useTauriZoom';

export const RAIL_WIDTH = 52;

// macOS Tauri traffic-light controls sit at the very top-left; nudge the rail's
// brand mark down so the window controls don't overlap it.
const TAURI_CONTROL_TOP = Math.ceil(28 / DEFAULT_APP_ZOOM);

type RailIconProps = {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    active: boolean;
    onPress: () => void;
    badgeCount?: number;
};

const RailIcon = React.memo(({ icon, label, active, onPress, badgeCount }: RailIconProps) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
            hitSlop={4}
            style={({ pressed, hovered }: any) => [
                styles.iconButton,
                active && styles.iconButtonActive,
                !active && (pressed || hovered) && styles.iconButtonHover,
            ]}
        >
            <Ionicons
                name={icon}
                size={20}
                color={active ? theme.colors.textLink : theme.colors.textSecondary}
            />
            {badgeCount != null && badgeCount > 0 && (
                <View style={styles.badge} pointerEvents="none">
                    <Text style={styles.badgeText} numberOfLines={1}>
                        {badgeCount > 99 ? '99+' : String(badgeCount)}
                    </Text>
                </View>
            )}
        </Pressable>
    );
});

export const RailNav = React.memo(() => {
    if (Platform.OS !== 'web') return null;
    return <RailNavInner />;
});

const RailNavInner = React.memo(() => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const safeArea = useSafeAreaInsets();
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
    const { totalUnread } = useNotificationFeed();

    const isSessions = pathname === '/' || pathname.startsWith('/session');
    const isInbox = pathname.startsWith('/inbox');
    const isTerminal = pathname.startsWith('/terminal');
    const isSettings = pathname.startsWith('/settings');

    const goHome = React.useCallback(() => router.navigate('/'), [router]);
    const goSessions = React.useCallback(() => router.navigate('/'), [router]);
    const goInbox = React.useCallback(() => router.navigate('/inbox'), [router]);
    const goTerminal = React.useCallback(() => router.navigate('/terminal/web' as any), [router]);
    const goSettings = React.useCallback(() => router.navigate('/settings'), [router]);

    const topPad = safeArea.top + (isMacTauri ? TAURI_CONTROL_TOP : 12);

    return (
        <View
            style={[styles.container, { paddingTop: topPad }]}
            {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
        >
            <Pressable
                onPress={goHome}
                accessibilityRole="button"
                accessibilityLabel={t('common.home')}
                hitSlop={6}
                style={({ pressed }: any) => [styles.brand, pressed && { opacity: 0.8 }]}
            >
                <Ionicons name="happy-outline" size={18} color={theme.colors.button.primary.tint} />
            </Pressable>

            <View style={styles.group}>
                <RailIcon icon="chatbubbles-outline" label={t('tabs.sessions')} active={isSessions} onPress={goSessions} />
                <RailIcon icon="mail-outline" label={t('tabs.inbox')} active={isInbox} onPress={goInbox} badgeCount={totalUnread} />
                <RailIcon icon="terminal-outline" label={t('tabs.terminal')} active={isTerminal} onPress={goTerminal} />
            </View>

            <View style={styles.spacer} />

            <RailIcon icon="settings-outline" label={t('tabs.settings')} active={isSettings} onPress={goSettings} />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: RAIL_WIDTH,
        height: '100%',
        alignItems: 'center',
        paddingBottom: 12,
        gap: 8,
        backgroundColor: theme.colors.groupped.background,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.divider,
    },
    brand: {
        width: 30,
        height: 30,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
        marginBottom: 4,
    },
    group: {
        alignItems: 'center',
        gap: 6,
    },
    spacer: {
        flex: 1,
    },
    iconButton: {
        width: 38,
        height: 38,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconButtonActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    iconButtonHover: {
        backgroundColor: theme.colors.surfaceSelected,
        opacity: 0.6,
    },
    badge: {
        position: 'absolute',
        top: 4,
        right: 4,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
    badgeText: {
        fontSize: 10,
        lineHeight: 12,
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
}));
