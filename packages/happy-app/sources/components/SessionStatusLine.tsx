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

interface SessionStatusLineProps {
    host?: string;
    cwd?: string;
    model?: string;
    isConnected?: boolean;
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

export const SessionStatusLine: React.FC<SessionStatusLineProps> = ({ host, cwd, model, isConnected }) => {
    const { theme } = useUnistyles();
    const parts = [host, shortenCwd(cwd), model].filter((x): x is string => !!x && x.length > 0);
    const dotColor = isConnected ? theme.colors.status.connected : theme.colors.textSecondary;

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.header.background, borderBottomColor: theme.colors.divider }]}>
            <View style={styles.inner}>
                <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={[styles.meta, { color: theme.colors.textSecondary, ...Typography.mono() }]}
                >
                    {parts.join('  ·  ')}
                </Text>
                <View style={styles.conn}>
                    <View style={[styles.dot, { backgroundColor: dotColor }]} />
                    <Text style={[styles.connText, { color: dotColor, ...Typography.mono() }]}>
                        {isConnected ? t('status.connected') : t('status.offline')}
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
