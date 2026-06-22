import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';
import { MainView } from './MainView';
import { AttentionBar } from './AttentionBar';
import { NewSessionModal } from './NewSessionModal';
import { StyleSheet } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { Platform } from 'react-native';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    newSessionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        gap: 8,
    },
    newSessionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    newSessionText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    footerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        gap: 10,
    },
    footerRowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    footerIcon: {
        position: 'relative',
    },
    footerDot: {
        position: 'absolute',
        top: -2,
        right: -3,
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.status.connected,
    },
    settingsText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default(),
    },
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();

    const handleNewSession = React.useCallback(() => {
        Modal.show({ component: NewSessionModal });
    }, []);

    return (
        <View style={[styles.container, { paddingTop: safeArea.top + headerHeight }]}>
            {/* New-session moved into the sidebar's top header row (SidebarNavigator). */}
            {realtimeStatus !== 'disconnected' && (
                <VoiceAssistantStatusBar variant="sidebar" />
            )}

            {/* "Needs attention" queue — sessions blocked on a permission request */}
            <AttentionBar />

            {/* Sessions list (terminals are rendered at the top of this list) */}
            <MainView variant="sidebar" />

            {/* Settings at bottom. Desktop has no tab bar. (Inbox removed — the
                notifications view wasn't pulling its weight here.) */}
            <Pressable
                onPress={() => router.push('/settings')}
                style={({ pressed }) => [styles.footerRow, pressed && styles.footerRowPressed]}
            >
                <Ionicons name="settings-outline" size={18} color={stylesheet.settingsText.color} />
                <Text style={styles.settingsText}>{t('settings.title')}</Text>
            </Pressable>
        </View>
    );
});
