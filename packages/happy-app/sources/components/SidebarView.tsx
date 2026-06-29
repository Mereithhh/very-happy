import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@/utils/responsive';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';
import { MainView } from './MainView';
import { AttentionBar } from './AttentionBar';
import { StyleSheet } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();

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

            {/* Settings now lives on the left icon rail (RailNav) — the sidebar's
                bottom settings row was removed to avoid two settings entries and
                keep this column visually clean. */}
        </View>
    );
});
