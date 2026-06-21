import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { useWindowDimensions, View, Text, Pressable, Platform } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { NewSessionModal } from './NewSessionModal';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Rect, Line } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { HeaderLogo } from './HeaderLogo';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { DEFAULT_APP_ZOOM } from '@/hooks/useTauriZoom';
import { canRouteForward, canUseRouteBack, getNavigatorCanGoBack } from '@/navigation/browserNavigation';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';

const TAURI_HEADER_CONTROL_LEFT = Math.ceil(92 / DEFAULT_APP_ZOOM);

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const zenMode = useLocalSetting('zenMode');
    const isDesktopLayout = auth.isAuthenticated && isTablet;
    const showSidebar = isDesktopLayout && !zenMode;
    const { width: windowWidth } = useWindowDimensions();

    // Calculate target drawer width
    const fullDrawerWidth = React.useMemo(() => {
        if (!isDesktopLayout) return 280;
        return Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
    }, [windowWidth, isDesktopLayout]);
    const drawerWidth = showSidebar ? fullDrawerWidth : 0;

    const drawerNavigationOptions = React.useMemo(() => {
        if (!isDesktopLayout) {
            // Non-tablet: use front drawer, hidden
            return {
                lazy: false,
                headerShown: false,
                drawerType: 'front' as const,
                swipeEnabled: false,
                drawerStyle: {
                    width: 0,
                    display: 'none' as const,
                },
            };
        }

        // Tablet: always permanent, just collapse width in zen mode.
        //
        // We deliberately do NOT animate `width` on web. A CSS transition on
        // the drawer width re-flowed the chat flex-1 sibling on every frame,
        // re-measuring the entire FlatList tree at ~15fps. Snapping the
        // width change makes the chat reflow exactly once. Native already
        // snaps because RN doesn't honor CSS transition properties.
        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: 'white',
                borderRightWidth: 0,
                width: drawerWidth,
                overflow: 'hidden' as const,
            } as any,
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [isDesktopLayout, drawerWidth]);

    const drawerContent = React.useCallback(
        () => <SidebarView />,
        []
    );

    return (
        <View style={{ flex: 1 }}>
            <Drawer
                screenOptions={drawerNavigationOptions}
                drawerContent={isDesktopLayout ? drawerContent : undefined}
            />
            {/* Persistent header overlay — always visible on desktop, same position regardless of zen mode */}
            {isDesktopLayout && (
                <PersistentHeader drawerWidth={fullDrawerWidth} showSidebar={showSidebar} />
            )}
        </View>
    );
});

// Header block that stays in the same position whether zen mode is on or off
const PersistentHeader = React.memo(({ drawerWidth, showSidebar }: { drawerWidth: number; showSidebar: boolean }) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

    const routeHistory = useBrowserNavigationStore((s) => s.routeHistory);
    const canGoForward = useBrowserNavigationStore((s) => s.routeHistory ? canRouteForward(s.routeHistory) : false);
    const overlayCanBack = useOverlayNav((s) => s.canBack);
    const overlayCanForward = useOverlayNav((s) => s.canForward);
    const canGoBack = routeHistory
        ? canUseRouteBack(routeHistory, getNavigatorCanGoBack(router))
        : false;

    const handleZenToggle = React.useCallback(() => {
        setZenMode(!zenMode);
    }, [zenMode, setZenMode]);

    const goHome = React.useCallback(() => {
        router.navigate('/');
    }, [router]);

    const handleNewSession = React.useCallback(() => {
        Modal.show({ component: NewSessionModal });
    }, []);

    const handleBack = React.useCallback(() => {
        // Intra-session overlay (file diff / file view) consumes back first,
        // so the chat → diff → file flow can be unwound without a close X.
        if (useOverlayNav.getState().back()) return;
        const nav = useBrowserNavigationStore.getState();
        if (!nav.routeHistory || !canUseRouteBack(nav.routeHistory, getNavigatorCanGoBack(router))) return;
        nav.markRouteBack();
        router.back();
    }, [router]);

    const handleForward = React.useCallback(() => {
        if (useOverlayNav.getState().forward()) return;
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            const nav = useBrowserNavigationStore.getState();
            if (!nav.routeHistory || !canRouteForward(nav.routeHistory)) return;
            nav.markRouteForward();
            window.history.forward();
        }
    }, []);

    const canGoBackEffective = canGoBack || overlayCanBack;
    const canGoForwardEffective = canGoForward || overlayCanForward;

    const backBtn = (
        <Pressable onPress={handleBack} disabled={!canGoBackEffective} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoBackEffective ? 1 : 0.35 }}>
            <Ionicons name="chevron-back" size={20} color={theme.colors.header.tint} />
        </Pressable>
    );
    const toggleBtn = (color: string) => (
        <Pressable onPress={handleZenToggle} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('zen.toggle')}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                <Rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke={color} strokeWidth={1.8} />
                <Line x1="9.5" y1="4.5" x2="9.5" y2="19.5" stroke={color} strokeWidth={1.8} />
            </Svg>
        </Pressable>
    );

    return (
        <View
            style={{ position: 'absolute', top: 0, left: 0, right: 0, height: safeArea.top + headerHeight, flexDirection: 'row', alignItems: 'flex-start', zIndex: 1100 }}
            pointerEvents="box-none"
            {...(inTauri ? { dataSet: { tauriDragRegion: 'true' } } : {})}
        >
            {showSidebar ? (
                /* Sidebar top bar: logo · back · 新建会话 · collapse — one row. */
                <View
                    style={{ width: drawerWidth, height: safeArea.top + headerHeight, paddingTop: safeArea.top, paddingLeft: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 12, paddingRight: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                    pointerEvents="auto"
                    {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
                >
                    <Pressable onPress={goHome} hitSlop={8} accessibilityLabel={t('common.home')}>
                        <HeaderLogo />
                    </Pressable>
                    {backBtn}
                    <Pressable
                        onPress={handleNewSession}
                        style={({ pressed }) => ({
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            height: 34,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor: pressed ? theme.colors.surfaceSelected : theme.colors.surfaceHigh,
                        })}
                        accessibilityLabel={t('sidebar.newSession')}
                    >
                        <Ionicons name="create-outline" size={15} color={theme.colors.text} />
                        <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }} numberOfLines={1}>
                            {t('sidebar.newSession')}
                        </Text>
                    </Pressable>
                    {toggleBtn(theme.colors.header.tint)}
                </View>
            ) : (
                /* Collapsed: just expand-toggle + back, top-left. */
                <View
                    style={{ paddingTop: safeArea.top, height: safeArea.top + headerHeight, paddingLeft: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 16, flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    pointerEvents="auto"
                    {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
                >
                    {toggleBtn(theme.colors.textLink)}
                    {backBtn}
                </View>
            )}
        </View>
    );
});
