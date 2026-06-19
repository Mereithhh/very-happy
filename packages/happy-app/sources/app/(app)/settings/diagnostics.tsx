/**
 * Diagnostics — one-screen health view for "why isn't remote working?".
 *
 * Self-hosted addition. Consolidates the signals that actually explain a dead
 * remote session: the relay socket, each machine's online state + daemon
 * status, and — the #1 culprit in this setup — whether the `claude` CLI is even
 * detectable on the daemon's PATH (cliAvailability). Read-only; everything here
 * comes from existing synced state.
 */

import * as React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSocketStatus, useRealtimeStatus } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { formatLastSeen } from '@/utils/sessionUtils';

function StatusDot({ color }: { color: string }) {
    return <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />;
}

export default function DiagnosticsScreen() {
    const { theme } = useUnistyles();
    const socket = useSocketStatus();
    const realtime = useRealtimeStatus();
    const machines = useAllMachines({ includeOffline: true });

    const ok = theme.colors.status.connected;
    const warn = theme.colors.status.connecting;
    const bad = theme.colors.status.disconnected ?? theme.colors.status.error;

    const socketColor = socket.status === 'connected' ? ok : socket.status === 'connecting' ? warn : bad;
    const onlineMachines = machines.filter(isMachineOnline);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Relay connection */}
            <ItemGroup title="Relay">
                <Item
                    title="Server socket"
                    subtitle={socket.status === 'connected'
                        ? `connected${socket.lastConnectedAt ? ' • since ' + formatLastSeen(socket.lastConnectedAt, false) : ''}`
                        : `${socket.status}${socket.lastDisconnectedAt ? ' • last drop ' + formatLastSeen(socket.lastDisconnectedAt, false) : ''}`}
                    icon={<Ionicons name="cloud-outline" size={29} color={socketColor} />}
                    rightElement={<StatusDot color={socketColor} />}
                    showChevron={false}
                />
                <Item
                    title="Realtime (voice)"
                    subtitle={realtime}
                    icon={<Ionicons name="radio-outline" size={29} color={realtime === 'connected' ? ok : realtime === 'connecting' ? warn : theme.colors.textSecondary} />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Machines / daemons */}
            <ItemGroup
                title="Machines & daemons"
                footer={machines.length === 0
                    ? 'No machines have connected to this account yet. Start the happy daemon on a machine and make sure its serverUrl points here.'
                    : onlineMachines.length === 0
                        ? 'No machine is online — remote sessions cannot run until a daemon connects.'
                        : undefined}
            >
                {machines.length === 0 ? (
                    <Item title="No machines" showChevron={false} />
                ) : machines.map((m) => {
                    const online = isMachineOnline(m);
                    const cli = m.metadata?.cliAvailability;
                    const daemon = m.metadata?.daemonLastKnownStatus;
                    const name = m.metadata?.displayName || m.metadata?.host || m.id;

                    const parts: string[] = [];
                    parts.push(online ? 'online' : `offline • ${formatLastSeen(m.activeAt, false)}`);
                    if (daemon) parts.push(`daemon ${daemon}`);
                    if (cli) {
                        // The remote/SDK path needs `claude` on PATH; flag it loudly.
                        parts.push(cli.claude ? 'claude ✓' : 'claude ✗ (remote will fail)');
                    } else if (online) {
                        parts.push('cli: unknown');
                    }

                    const claudeMissing = online && cli && !cli.claude;
                    return (
                        <Item
                            key={m.id}
                            title={name}
                            subtitle={parts.join(' • ')}
                            subtitleStyle={claudeMissing ? { color: bad } : undefined}
                            icon={<Ionicons name="desktop-outline" size={29} color={online ? ok : theme.colors.status.disconnected} />}
                            rightElement={<StatusDot color={online ? ok : theme.colors.status.disconnected} />}
                            showChevron={false}
                        />
                    );
                })}
            </ItemGroup>

            {/* Hint */}
            <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
                <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.textSecondary, lineHeight: 18 }}>
                    Remote (web) sessions run claude via the daemon's PATH. If a machine is online but shows "claude ✗", the daemon can't find the claude binary — fix its PATH (e.g. add ~/.local/bin) and restart the daemon.
                </Text>
            </View>
        </ItemList>
    );
}
