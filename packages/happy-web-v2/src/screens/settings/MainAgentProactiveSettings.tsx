/**
 * Settings → Main agent → 主动程度 (B-925). Writes `proactive` into KV
 * `vh.main-agent-config.v1` (every other field of that blob is kept): the
 * level (off / report only / follow up) and the daily wake-up / token caps.
 * Read by the main agent's daemon within a minute.
 */

import { useEffect, useMemo, useState } from 'react';
import { MAIN_AGENT_PROACTIVE_BOUNDS, readMainAgentProactive, type MainAgentProactiveConfig, type MainAgentProactiveLevel } from '@slopus/happy-wire';
import { Button, Input, ItemGroup, Segmented, toast } from '@/ui';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import { kvMutate } from '@/sync/apiKv';
import { decodeKvJson, encodeKvJson, MAIN_AGENT_CONFIG_KEY, parseMainAgentConfig } from '@/assistant/mainAgent';
import { useMainAgentStore } from '@/assistant/mainAgentStore';
import { mainAgentProactiveCopy, parseCap, withProactive } from '@/assistant/mainAgentProactive';
import './mainAgentProactive.css';

async function save(creds: NonNullable<ReturnType<typeof useAuth>['credentials']>, proactive: MainAgentProactiveConfig): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const { configRaw, configVersion } = useMainAgentStore.getState();
        const merged = withProactive(configRaw, proactive, Date.now());
        const res = await kvMutate(creds, [{ key: MAIN_AGENT_CONFIG_KEY, value: encodeKvJson(merged), version: configVersion }]);
        if (res.success) {
            useMainAgentStore.setState({ configRaw: merged, config: parseMainAgentConfig(merged), configVersion: res.results[0].version, configStatus: 'ready' });
            return true;
        }
        const err = res.errors[0];
        const raw = err.value ? decodeKvJson(err.value) : null;
        useMainAgentStore.setState({ configRaw: raw, config: parseMainAgentConfig(raw), configVersion: err.version });
    }
    return false;
}

export function MainAgentProactiveSettings() {
    const { lang } = useTranslation();
    const copy = mainAgentProactiveCopy(lang);
    const { credentials } = useAuth();
    const configStatus = useMainAgentStore((s) => s.configStatus);
    const configRaw = useMainAgentStore((s) => s.configRaw);
    const current = useMemo(() => readMainAgentProactive(configRaw), [configRaw]);
    const [wakes, setWakes] = useState(String(current.dailyWakes));
    const [tokens, setTokens] = useState(String(current.dailyTokens));
    const [saving, setSaving] = useState(false);
    useEffect(() => { setWakes(String(current.dailyWakes)); setTokens(String(current.dailyTokens)); }, [current.dailyWakes, current.dailyTokens]);

    const wakesValue = parseCap(wakes, 'dailyWakes');
    const tokensValue = parseCap(tokens, 'dailyTokens');
    const capsDirty = wakesValue !== current.dailyWakes || tokensValue !== current.dailyTokens;
    const ready = configStatus === 'ready' && !!credentials;

    const write = async (next: MainAgentProactiveConfig) => {
        if (!credentials) return;
        setSaving(true);
        try {
            if (await save(credentials, next)) toast.success(copy.saved);
            else toast.error(copy.saveFailed);
        } catch {
            toast.error(copy.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    const levels: Array<{ value: MainAgentProactiveLevel; label: string }> = [
        { value: 'off', label: copy.levelOff },
        { value: 'report', label: copy.levelReport },
        { value: 'follow', label: copy.levelFollow },
    ];

    return (
        <ItemGroup settingId="mainAgent.proactive" title={copy.title} footer={copy.levelHint[current.level]}>
            <div className="map-field" data-testid="main-agent-proactive">
                <Segmented label={copy.title} options={levels} value={current.level} disabled={!ready || saving}
                    onChange={(level) => void write({ ...current, level })} />
                <div className="map-caps">
                    <Input label={copy.dailyWakes} inputMode="numeric" value={wakes} disabled={!ready || current.level === 'off'}
                        error={wakesValue === null ? copy.capInvalid(MAIN_AGENT_PROACTIVE_BOUNDS.dailyWakes[1]) : null}
                        onChange={(e) => setWakes(e.target.value)} />
                    <Input label={copy.dailyTokens} inputMode="numeric" value={tokens} disabled={!ready || current.level === 'off'}
                        error={tokensValue === null ? copy.capInvalid(MAIN_AGENT_PROACTIVE_BOUNDS.dailyTokens[1]) : null}
                        onChange={(e) => setTokens(e.target.value)} />
                </div>
                <div className="map-actions">
                    <span className="map-note">{copy.capsHint}</span>
                    <Button variant="secondary" loading={saving} disabled={!ready || !capsDirty || wakesValue === null || tokensValue === null}
                        onClick={() => void write({ ...current, dailyWakes: wakesValue!, dailyTokens: tokensValue! })}>{copy.saveCaps}</Button>
                </div>
            </div>
        </ItemGroup>
    );
}
