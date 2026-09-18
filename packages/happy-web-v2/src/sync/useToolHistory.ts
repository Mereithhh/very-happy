import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { sync } from './sync';
import { apiSocket, getHappyClientId } from './apiSocket';
import { getServerUrl } from './serverConfig';
import { onKvChanges } from './kvUpdates';
import { createToolHistoryFeed } from './toolHistoryFeed';
import { decodeToolHistory, toolHistoryKey, type ToolHistoryEntry, type ToolHistoryScope } from './toolHistory';

export function useToolHistory(scope: ToolHistoryScope) {
    const { credentials } = useAuth();
    const key = toolHistoryKey(scope);
    const sourceId = 'sessionId' in scope ? scope.sessionId : scope.machineId;
    const isSession = 'sessionId' in scope;
    const [snapshot, setSnapshot] = useState<{key: string; token?: string; entries: ToolHistoryEntry[]; failed: boolean}>({ key, entries: [], failed: false });
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        if (!credentials) return;
        const identity = {key, token: credentials.token};
        setSnapshot({...identity, entries: [], failed: false});
        const feed = createToolHistoryFeed({key,
            async read(signal) {
                const res = await fetch(`${getServerUrl()}/v1/kv/${encodeURIComponent(key)}`, {
                    headers: {Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId()},
                    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
                });
                if (res.status === 404) return {value: null, version: -1};
                if (!res.ok) throw new Error('Tool history unavailable');
                const data = await res.json();
                if (!Number.isSafeInteger(data.version) || typeof data.value !== 'string') throw new Error('Invalid tool history');
                return data;
            },
            decode: value => decodeToolHistory(value, async payload => {
                const encryption = isSession ? sync.encryption?.getSessionEncryption(sourceId) : sync.encryption?.getMachineEncryption(sourceId);
                return encryption ? encryption.decryptRaw(payload) : null;
            }),
            onEntries: entries => setSnapshot({...identity, entries, failed: false}),
            onError: failed => setSnapshot(previous => ({...previous, ...identity, failed})),
        });
        const removeKv = onKvChanges(changes => feed.changes(changes));
        const removeReconnect = apiSocket.onReconnected(() => void feed.refresh());
        const removeRecovered = apiSocket.onRecovered(() => void feed.refresh());
        void feed.refresh();
        return () => { feed.dispose(); removeKv(); removeReconnect(); removeRecovered(); };
    }, [key, credentials?.token, sourceId, isSession, revision]);
    const current = snapshot.key === key && snapshot.token === credentials?.token;
    return {entries: current ? snapshot.entries : [], failed: current && snapshot.failed, retry: () => setRevision(v => v + 1)};
}
