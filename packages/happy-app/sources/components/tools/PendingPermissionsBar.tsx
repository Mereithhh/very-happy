import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { useSession } from '@/sync/storage';
import { t } from '@/text';

interface PendingRequest {
    id: string;
    tool: string;
}

/**
 * PendingPermissionsBar — a compact "approve / deny all" bar shown when MORE
 * THAN ONE permission request is pending in a session at once. Single pending
 * requests are handled inline by the per-tool PermissionFooter; this bar only
 * appears when batching actually saves the user taps.
 *
 * Rendered as an overlay pinned to the bottom of the chat area (above the
 * composer) by ChatList — it intentionally does not touch the SessionView
 * status strip.
 */
export const PendingPermissionsBar = React.memo((props: { sessionId: string }) => {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const [busy, setBusy] = React.useState<'allow' | 'deny' | null>(null);

    const isCodex = session?.metadata?.flavor === 'codex';

    const pending = React.useMemo<PendingRequest[]>(() => {
        const requests = session?.agentState?.requests;
        if (!requests) return [];
        return Object.entries(requests).map(([id, r]) => ({ id, tool: (r as any)?.tool ?? '' }));
    }, [session?.agentState?.requests]);

    const count = pending.length;

    const handleApproveAll = React.useCallback(async () => {
        if (busy) return;
        setBusy('allow');
        try {
            // Snapshot ids up front — approving mutates agentState.requests.
            const ids = pending.map((p) => p.id);
            for (const id of ids) {
                try {
                    if (isCodex) {
                        await sessionAllow(props.sessionId, id, undefined, undefined, 'approved');
                    } else {
                        await sessionAllow(props.sessionId, id);
                    }
                } catch (e) {
                    console.error('Batch approve failed for', id, e);
                }
            }
        } finally {
            setBusy(null);
        }
    }, [busy, pending, isCodex, props.sessionId]);

    const handleDenyAll = React.useCallback(async () => {
        if (busy) return;
        setBusy('deny');
        try {
            const ids = pending.map((p) => p.id);
            for (const id of ids) {
                try {
                    if (isCodex) {
                        await sessionDeny(props.sessionId, id, undefined, undefined, 'abort');
                    } else {
                        await sessionDeny(props.sessionId, id);
                    }
                } catch (e) {
                    console.error('Batch deny failed for', id, e);
                }
            }
        } finally {
            setBusy(null);
        }
    }, [busy, pending, isCodex, props.sessionId]);

    const accent = (theme.colors as any).permissionButton?.allow?.background
        ?? (theme.colors as any).permission?.approve
        ?? theme.colors.success
        ?? theme.colors.text;
    const accentText = (theme.colors as any).permissionButton?.allow?.text ?? '#FFFFFF';

    const styles = StyleSheet.create({
        container: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 12,
            backgroundColor: theme.colors.surfaceHigh,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.divider,
            shadowColor: theme.colors.shadow.color,
            shadowOffset: { width: 0, height: 2 },
            shadowRadius: 6,
            shadowOpacity: theme.colors.shadow.opacity,
            elevation: 4,
        },
        label: {
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
        },
        labelText: {
            flexShrink: 1,
            fontSize: 13,
            fontWeight: '600',
            color: theme.colors.text,
        },
        denyButton: {
            minHeight: 38,
            minWidth: 72,
            borderRadius: 9,
            paddingHorizontal: 12,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: theme.colors.textSecondary,
        },
        denyText: {
            fontSize: 14,
            fontWeight: '600',
            color: theme.colors.text,
        },
        approveButton: {
            minHeight: 38,
            borderRadius: 9,
            paddingHorizontal: 16,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: accent,
        },
        approveText: {
            fontSize: 14,
            fontWeight: '700',
            color: accentText,
        },
    });

    // Only show when batching is useful (2+ pending requests).
    if (count < 2) return null;

    return (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} style={styles.container}>
            <View style={styles.label}>
                <Ionicons name="shield-checkmark-outline" size={18} color={accent} />
                <Text style={styles.labelText} numberOfLines={1}>
                    {t('permissions.pendingCount', { count })}
                </Text>
            </View>
            <TouchableOpacity
                style={styles.denyButton}
                onPress={handleDenyAll}
                disabled={busy !== null}
                activeOpacity={0.7}
            >
                {busy === 'deny' ? (
                    <ActivityIndicator size="small" color={theme.colors.text} />
                ) : (
                    <Text style={styles.denyText} numberOfLines={1}>{t('permissions.denyAll')}</Text>
                )}
            </TouchableOpacity>
            <TouchableOpacity
                style={styles.approveButton}
                onPress={handleApproveAll}
                disabled={busy !== null}
                activeOpacity={0.85}
            >
                {busy === 'allow' ? (
                    <ActivityIndicator size="small" color={accentText} />
                ) : (
                    <Text style={styles.approveText} numberOfLines={1}>{t('permissions.approveAll')}</Text>
                )}
            </TouchableOpacity>
        </Animated.View>
    );
});
