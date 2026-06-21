import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { useSettingMutable, useProfile } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { useConnectAccount } from '@/hooks/useConnectAccount';
import { getDisplayName } from '@/sync/profile';
import { Image } from 'expo-image';
import { useHappyAction } from '@/hooks/useHappyAction';
import { disconnectGitHub } from '@/sync/apiGithub';
import { disconnectService } from '@/sync/apiServices';
import {
    getPushPermissionInfo,
    requestPushPermissionOrOpenSettings,
    syncCurrentPushToken,
    type PushPermissionInfo,
} from '@/sync/pushRegistration';

function formatPushPermissionLabel(permission: PushPermissionInfo | null): string {
    if (!permission) {
        return 'Loading';
    }
    if (permission.status === 'unsupported') {
        return 'Unavailable';
    }
    if (permission.granted) {
        return 'Allowed';
    }
    if (permission.status === 'denied') {
        return 'Denied';
    }
    return 'Not requested';
}

function formatPushPermissionSubtitle(permission: PushPermissionInfo | null): string {
    if (!permission) {
        return 'Checking push notification permissions for this device.';
    }
    if (permission.status === 'unsupported') {
        return 'Push notification permissions are only managed on mobile devices.';
    }
    if (permission.granted) {
        return 'This device can receive push notifications.';
    }
    if (permission.canAskAgain) {
        return 'The system prompt can still be shown again from the app.';
    }
    return 'iOS has stopped prompting. Open system settings to enable notifications again.';
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const [showSecret, setShowSecret] = useState(false);
    const [copiedRecently, setCopiedRecently] = useState(false);
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');
    const { connectAccount, isLoading: isConnecting } = useConnectAccount();
    const profile = useProfile();
    const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
    const [loadingPushSettings, setLoadingPushSettings] = useState(false);
    const [requestingPushPermission, setRequestingPushPermission] = useState(false);

    // Get the current secret key
    const currentSecret = auth.credentials?.secret || '';
    const formattedSecret = currentSecret ? formatSecretKeyForBackup(currentSecret) : '';

    // Profile display values
    const displayName = getDisplayName(profile);
    const githubUsername = profile.github?.login;

    const loadPushSettings = useCallback(async (showError = false) => {
        if (!auth.credentials) {
            setPushPermission(null);
            return;
        }

        setLoadingPushSettings(true);
        try {
            const permission = await getPushPermissionInfo();
            setPushPermission(permission);
        } catch (error) {
            console.error('Failed to load push notification settings:', error);
            if (showError) {
                Modal.alert(t('common.error'), 'Failed to load push notification settings.');
            }
        } finally {
            setLoadingPushSettings(false);
        }
    }, [auth.credentials]);

    useEffect(() => {
        void loadPushSettings();
    }, [loadPushSettings]);

    useFocusEffect(
        useCallback(() => {
            void loadPushSettings();
        }, [loadPushSettings])
    );

    // GitHub disconnection
    const [disconnecting, handleDisconnectGitHub] = useHappyAction(async () => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectGithub'),
            t('modals.disconnectGithubConfirm'),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            await disconnectGitHub(auth.credentials!);
        }
    });

    // Service disconnection
    const [disconnectingService, setDisconnectingService] = useState<string | null>(null);
    const handleDisconnectService = async (service: string, displayName: string) => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectService', { service: displayName }),
            t('modals.disconnectServiceConfirm', { service: displayName }),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            setDisconnectingService(service);
            try {
                await disconnectService(auth.credentials!, service);
                await sync.refreshProfile();
                // The profile will be updated via sync
            } catch (error) {
                Modal.alert(t('common.error'), t('errors.disconnectServiceFailed', { service: displayName }));
            } finally {
                setDisconnectingService(null);
            }
        }
    };

    const handleShowSecret = () => {
        setShowSecret(!showSecret);
    };

    const handleCopySecret = async () => {
        try {
            await Clipboard.setStringAsync(formattedSecret);
            setCopiedRecently(true);
            setTimeout(() => setCopiedRecently(false), 2000);
            Modal.alert(t('common.success'), t('settingsAccount.secretKeyCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
        }
    };

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            t('common.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('common.logout'), destructive: true }
        );
        if (confirmed) {
            auth.logout();
        }
    };

    const handlePushPermissionRequest = useCallback(async () => {
        if (!auth.credentials) {
            return;
        }

        setRequestingPushPermission(true);
        try {
            const result = await requestPushPermissionOrOpenSettings();
            setPushPermission(result.permission);

            if (result.granted) {
                await syncCurrentPushToken(auth.credentials);
                await loadPushSettings();
                Modal.alert(t('common.success'), 'Push notifications are enabled for this device.');
                return;
            }

            await loadPushSettings();

            if (result.openedSettings) {
                Modal.alert('Open Settings', 'The system will not show the permission prompt again, so Happy opened Settings instead.');
                return;
            }

            Modal.alert(t('common.error'), 'Push notification permission was not granted.');
        } catch (error) {
            console.error('Failed to request push permission:', error);
            Modal.alert(t('common.error'), 'Failed to request push notification permission.');
        } finally {
            setRequestingPushPermission(false);
        }
    }, [auth.credentials, loadPushSettings]);

    return (
        <>
            <ItemList>
                {/* Account Info */}
                <ItemGroup title={t('settingsAccount.accountInformation')}>
                    {Platform.OS !== 'web' && (
                        <Item
                            title={t('settingsAccount.linkNewDevice')}
                            subtitle={isConnecting ? t('common.scanning') : t('settingsAccount.linkNewDeviceSubtitle')}
                            icon={<Ionicons name="qr-code-outline" size={29} color={theme.colors.textSecondary} />}
                            onPress={connectAccount}
                            disabled={isConnecting}
                            showChevron={false}
                        />
                    )}
                    <Item
                        title={t('settingsAccount.password')}
                        subtitle={t('settingsAccount.passwordSet')}
                        icon={<Ionicons name="key-outline" size={29} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/settings/password')}
                    />
                </ItemGroup>

                {/* Profile Section */}
                {(displayName || githubUsername || profile.avatar) && (
                    <ItemGroup title={t('settingsAccount.profile')}>
                        {githubUsername && (
                            <Item
                                title={t('settingsAccount.github')}
                                detail={`@${githubUsername}`}
                                subtitle={t('settingsAccount.tapToDisconnect')}
                                onPress={handleDisconnectGitHub}
                                loading={disconnecting}
                                showChevron={false}
                                icon={profile.avatar?.url ? (
                                    <Image
                                        source={{ uri: profile.avatar.url }}
                                        style={{ width: 29, height: 29, borderRadius: 14.5 }}
                                        placeholder={{ thumbhash: profile.avatar.thumbhash }}
                                        contentFit="cover"
                                        transition={200}
                                        cachePolicy="memory-disk"
                                    />
                                ) : (
                                    <Ionicons name="logo-github" size={29} color={theme.colors.textSecondary} />
                                )}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Connected Services Section */}
                {profile.connectedServices && profile.connectedServices.length > 0 && (() => {
                    // Map of service IDs to display names and icons
                    const knownServices = {
                        anthropic: { name: 'Claude Code', icon: require('@/assets/images/icon-claude.png'), tintColor: null },
                        gemini: { name: 'Google Gemini', icon: require('@/assets/images/icon-gemini.png'), tintColor: null },
                        openai: { name: 'OpenAI Codex', icon: require('@/assets/images/icon-gpt.png'), tintColor: theme.colors.text }
                    };
                    
                    // Filter to only known services
                    const displayServices = profile.connectedServices.filter(
                        service => service in knownServices
                    );
                    
                    if (displayServices.length === 0) return null;
                    
                    return (
                        <ItemGroup title={t('settings.connectedAccounts')}>
                            {displayServices.map(service => {
                                const serviceInfo = knownServices[service as keyof typeof knownServices];
                                const isDisconnecting = disconnectingService === service;
                                return (
                                    <Item
                                        key={service}
                                        title={serviceInfo.name}
                                        detail={t('settingsAccount.statusActive')}
                                        subtitle={t('settingsAccount.tapToDisconnect')}
                                        onPress={() => handleDisconnectService(service, serviceInfo.name)}
                                        loading={isDisconnecting}
                                        disabled={isDisconnecting}
                                        showChevron={false}
                                        icon={
                                            <Image
                                                source={serviceInfo.icon}
                                                style={{ width: 29, height: 29 }}
                                                tintColor={serviceInfo.tintColor}
                                                contentFit="contain"
                                            />
                                        }
                                    />
                                );
                            })}
                        </ItemGroup>
                    );
                })()}

                {/* Backup Section */}
                <ItemGroup
                    title={t('settingsAccount.backup')}
                    footer={t('settingsAccount.backupDescription')}
                >
                    <Item
                        title={t('settingsAccount.secretKey')}
                        subtitle={showSecret ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                        icon={<Ionicons name={showSecret ? "eye-off-outline" : "eye-outline"} size={29} color={theme.colors.textSecondary} />}
                        onPress={handleShowSecret}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Secret Key Display */}
                {showSecret && (
                    <ItemGroup>
                        <Pressable onPress={handleCopySecret}>
                            <View style={{
                                backgroundColor: theme.colors.surface,
                                paddingHorizontal: 16,
                                paddingVertical: 14,
                                width: '100%',
                                maxWidth: layout.maxWidth,
                                alignSelf: 'center'
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: theme.colors.textSecondary,
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        ...Typography.default('semiBold')
                                    }}>
                                        {t('settingsAccount.secretKeyLabel')}
                                    </Text>
                                    <Ionicons
                                        name={copiedRecently ? "checkmark-circle" : "copy-outline"}
                                        size={18}
                                        color={copiedRecently ? theme.colors.success : theme.colors.textSecondary}
                                    />
                                </View>
                                <Text style={{
                                    fontSize: 13,
                                    letterSpacing: 0.5,
                                    lineHeight: 20,
                                    color: theme.colors.text,
                                    ...Typography.mono()
                                }}>
                                    {formattedSecret}
                                </Text>
                            </View>
                        </Pressable>
                    </ItemGroup>
                )}

                {/* Analytics Section */}
                <ItemGroup
                    title={t('settingsAccount.privacy')}
                    footer={t('settingsAccount.privacyDescription')}
                >
                    <Item
                        title={t('settingsAccount.analytics')}
                        subtitle={analyticsOptOut ? t('settingsAccount.analyticsDisabled') : t('settingsAccount.analyticsEnabled')}
                        rightElement={
                            <Switch
                                value={!analyticsOptOut}
                                onValueChange={(value) => {
                                    const optOut = !value;
                                    setAnalyticsOptOut(optOut);
                                }}
                                trackColor={{ false: theme.colors.switch.track.inactive, true: theme.colors.switch.track.active }}
                                thumbColor={theme.colors.switch.thumb.active}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup
                    title="Push Notifications"
                    footer="Shows every push token registered on your account. Tap an old token to delete it."
                >
                    <Item
                        title="Permission"
                        detail={formatPushPermissionLabel(pushPermission)}
                        subtitle={formatPushPermissionSubtitle(pushPermission)}
                        icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.textSecondary} />}
                        loading={loadingPushSettings}
                        showChevron={false}
                    />
                    <Item
                        title="Request Permission Again"
                        subtitle={pushPermission?.status === 'unsupported'
                            ? 'Push notification permissions are only available on iPhone and Android.'
                            : pushPermission?.canAskAgain
                            ? 'Shows the system prompt again if iOS still allows it.'
                            : 'Opens system settings when iOS will not prompt again.'}
                        icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.textSecondary} />}
                        onPress={handlePushPermissionRequest}
                        loading={requestingPushPermission}
                        disabled={requestingPushPermission || loadingPushSettings || pushPermission?.status === 'unsupported' || !auth.credentials}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Danger Zone */}
                <ItemGroup title={t('settingsAccount.dangerZone')}>
                    <Item
                        title={t('settingsAccount.logout')}
                        subtitle={t('settingsAccount.logoutSubtitle')}
                        icon={<Ionicons name="log-out-outline" size={29} color={theme.colors.textDestructive} />}
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
});
