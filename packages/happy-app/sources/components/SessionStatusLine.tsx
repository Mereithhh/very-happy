import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';

/**
 * The "Console" signature: a thin monospace status line under the session
 * header carrying the machine layer — machine · cwd · model — and a live
 * connection dot. Rendered as its own bar (not inside the header) so it stays
 * off the shared headerHeight math; SessionView accounts for its height.
 */
export const SESSION_STATUS_LINE_HEIGHT = 28;

type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

interface SessionStatusLineProps {
    host?: string;
    cwd?: string;
    model?: string;
    effort?: string;
    /** Boolean shorthand. Prefer `connectionState` for the three-state signal. */
    isConnected?: boolean;
    connectionState?: ConnectionState;
}

/** Keep the cwd readable: collapse a home-dir prefix and cap the depth. */
function shortenCwd(cwd?: string): string | undefined {
    if (!cwd) return undefined;
    let p = cwd.replace(/\\/g, '/');
    p = p.replace(/^\/(Users|home)\/[^/]+/, '~');
    const segs = p.split('/').filter(Boolean);
    if (segs.length > 3) return (p.startsWith('~') ? '~/…/' : '…/') + segs.slice(-2).join('/');
    return p;
}

export const SessionStatusLine: React.FC<SessionStatusLineProps> = ({ host, cwd, model, effort, isConnected, connectionState }) => {
    const { theme } = useUnistyles();
    const parts = [host, shortenCwd(cwd), model, effort].filter((x): x is string => !!x && x.length > 0);

    // Resolve the three-state connection signal (falls back to the boolean).
    const state: ConnectionState = connectionState ?? (isConnected ? 'connected' : 'disconnected');
    const connColor =
        state === 'connected' ? theme.colors.status.connected :
        state === 'reconnecting' ? theme.colors.warning :
        theme.colors.textSecondary;
    const connLabel =
        state === 'connected' ? t('status.connected') :
        state === 'reconnecting' ? t('status.connecting') :
        t('status.offline');

    return (
        <View
            style={[styles.container, { backgroundColor: theme.colors.header.background, borderBottomColor: theme.colors.divider }]}
            // Read the whole line as one labelled status region, not per-span fragments.
            accessibilityRole="text"
            accessibilityLabel={`${parts.join(', ')}, ${connLabel}`}
        >
            <View style={styles.inner}>
                <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={[styles.meta, { color: theme.colors.textSecondary, ...Typography.mono() }]}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    {parts.join('  ·  ')}
                </Text>
                <View style={styles.conn} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <View style={[styles.dot, { backgroundColor: connColor }]} />
                    <Text style={[styles.connText, { color: connColor, ...Typography.mono() }]}>
                        {connLabel}
                    </Text>
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        height: SESSION_STATUS_LINE_HEIGHT,
        width: '100%',
        alignItems: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        justifyContent: 'center',
    },
    inner: {
        width: '100%',
        maxWidth: layout.headerMaxWidth,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
    },
    meta: {
        flex: 1,
        fontSize: 11,
        letterSpacing: 0.2,
        minWidth: 0,
    },
    conn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    connText: {
        fontSize: 11,
        letterSpacing: 0.2,
    },
});
