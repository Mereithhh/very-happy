import * as React from 'react';
import { Platform, View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    useNotificationPrefs,
    setNotificationPrefs,
    setTypeEnabled,
    setQuietHours,
    formatMinute,
    getNotificationPrefs,
} from '@/sync/notificationPrefs';
import {
    requestNotificationPermission,
    getNotificationPermission,
} from '@/sync/webNotifications';
import type { NotifType } from '@/sync/feedTypes';

const stylesheet = StyleSheet.create((theme) => ({
    timeValue: {
        ...Typography.default('regular'),
        fontSize: 17,
        color: theme.colors.textLink,
    },
}));

const TYPE_META: { key: NotifType; icon: keyof typeof Ionicons.glyphMap; color: (theme: any) => string }[] = [
    { key: 'permission_request', icon: 'shield-checkmark-outline', color: (th) => th.colors.permission?.bypass ?? th.colors.status.connecting },
    { key: 'input_needed', icon: 'chatbubble-ellipses-outline', color: (th) => th.colors.status.connecting },
    { key: 'reply_done', icon: 'checkmark-circle-outline', color: (th) => th.colors.success },
    { key: 'error', icon: 'alert-circle-outline', color: (th) => th.colors.status.error },
];

// Web-only native time picker, rendered as a real DOM <input type="time">.
function WebTimeInput({ minute, onChange }: { minute: number; onChange: (minute: number) => void }) {
    const { theme } = useUnistyles();
    if (Platform.OS !== 'web') {
        return null;
    }
    const value = formatMinute(minute);
    return React.createElement('input', {
        type: 'time',
        value,
        onChange: (e: any) => {
            const v: string = e?.target?.value ?? '';
            const m = /^(\d{2}):(\d{2})$/.exec(v);
            if (m) onChange(parseInt(m[1], 10) * 60 + parseInt(m[2], 10));
        },
        style: {
            background: 'transparent',
            border: 'none',
            color: theme.colors.textLink,
            fontSize: 17,
            fontFamily: 'inherit',
            outline: 'none',
            cursor: 'pointer',
            colorScheme: theme.dark ? 'dark' : 'light',
        },
    });
}

export default function NotificationsSettingsScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const prefs = useNotificationPrefs();
    const [permission, setPermission] = React.useState<NotificationPermission | 'unsupported'>(getNotificationPermission());

    const supported = permission !== 'unsupported';
    const denied = permission === 'denied';

    const onToggleMaster = React.useCallback(async (value: boolean) => {
        if (value) {
            // Enabling: ensure browser permission before turning on.
            const result = await requestNotificationPermission();
            setPermission(result);
            // requestNotificationPermission flips the master flag on grant.
            if (result !== 'granted') {
                setNotificationPrefs({ ...getNotificationPrefs(), enabled: false });
            }
        } else {
            setNotificationPrefs({ ...getNotificationPrefs(), enabled: false });
        }
    }, []);

    // Non-web platforms: feature is web-only.
    if (Platform.OS !== 'web') {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup footer={t('notifications.webOnlyDescription')}>
                    <Item
                        title={t('notifications.webOnly')}
                        icon={<Ionicons name="globe-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('notifications.browserNotifications')}
                footer={
                    denied
                        ? t('notifications.permissionDeniedHint')
                        : t('notifications.masterDescription')
                }
            >
                <Item
                    title={t('notifications.enable')}
                    subtitle={
                        !supported
                            ? t('notifications.unsupported')
                            : prefs.enabled
                                ? t('notifications.enabledOn')
                                : t('notifications.enabledOff')
                    }
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.status.connecting} />}
                    rightElement={
                        <Switch
                            value={prefs.enabled && permission === 'granted'}
                            onValueChange={onToggleMaster}
                            disabled={!supported || denied}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('notifications.types')}
                footer={t('notifications.typesDescription')}
            >
                {TYPE_META.map(({ key, icon, color }) => (
                    <Item
                        key={key}
                        title={(t as any)(`notifications.type_${key}`)}
                        subtitle={(t as any)(`notifications.type_${key}_desc`)}
                        icon={<Ionicons name={icon} size={29} color={color(theme)} />}
                        rightElement={
                            <Switch
                                value={prefs.types[key]}
                                onValueChange={(v) => setTypeEnabled(key, v)}
                                disabled={!prefs.enabled}
                            />
                        }
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('notifications.quietHours')}
                footer={t('notifications.quietHoursDescription')}
            >
                <Item
                    title={t('notifications.quietHoursEnable')}
                    icon={<Ionicons name="moon-outline" size={29} color={theme.colors.permission?.plan ?? theme.colors.status.connecting} />}
                    rightElement={
                        <Switch
                            value={prefs.quietHours.enabled}
                            onValueChange={(v) => setQuietHours({ enabled: v })}
                            disabled={!prefs.enabled}
                        />
                    }
                    showChevron={false}
                />
                {prefs.quietHours.enabled && (
                    <>
                        <Item
                            title={t('notifications.quietHoursStart')}
                            icon={<Ionicons name="time-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={
                                <WebTimeInput
                                    minute={prefs.quietHours.startMinute}
                                    onChange={(m) => setQuietHours({ startMinute: m })}
                                />
                            }
                            showChevron={false}
                        />
                        <Item
                            title={t('notifications.quietHoursEnd')}
                            icon={<Ionicons name="time-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={
                                <WebTimeInput
                                    minute={prefs.quietHours.endMinute}
                                    onChange={(m) => setQuietHours({ endMinute: m })}
                                />
                            }
                            showChevron={false}
                        />
                    </>
                )}
            </ItemGroup>
        </ItemList>
    );
}
