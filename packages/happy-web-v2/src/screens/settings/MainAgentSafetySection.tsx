/**
 * Settings → Main agent → Safety (B-922, specs/2026-11-main-agent.md §4.4).
 *
 * Preset (strict / standard / loose) + advanced per-item overrides +
 * always-allowed tools, written to `vh.main-agent-config.v1.safety`. Shown
 * only when the main agent's machine runs a CLI with the safety capability;
 * otherwise an upgrade note (that CLI runs strict). Loosening is owner-only on
 * the server: a refusal is shown inline with what to do, never a silent fail.
 */

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { DispatchPolicy, MainAgentSafetyPolicy, SafetyPreset, ToolPolicy } from '@slopus/happy-wire';
import { Button, Checkbox, ItemGroup, Item, Segmented, toast } from '@/ui';
import { CollapsePanel } from '@/ui/CollapsePanel';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import type { Machine } from '@/sync/storageTypes';
import { useMainAgentStore } from '@/assistant/mainAgentStore';
import { parseMainAgentConfig } from '@/assistant/mainAgent';
import { mainAgentSafetyCopy } from '@/assistant/mainAgentSafetyCopy';
import {
    draftPolicy, mainAgentSafetySupported, overrideCount, readSafety, sameDraft, saveMainAgentSafety,
    setDraftItem, setDraftPreset, type SafetyDraft,
} from '@/assistant/mainAgentSafety';
import './mainAgentSafety.css';

const TOOL_CLASSES = ['production', 'outbound', 'thirdPartyWrite'] as const;
const DISPATCH_KEYS = ['dispatchExternal', 'dispatchProduction'] as const;

export function MainAgentSafetySection({ machine }: { machine: Machine | null }) {
    const { lang } = useTranslation();
    const copy = mainAgentSafetyCopy(lang);
    const { credentials } = useAuth();
    const configStatus = useMainAgentStore((s) => s.configStatus);
    const configRaw = useMainAgentStore((s) => s.configRaw);
    const stored = useMemo(() => readSafety(configRaw), [configRaw]);
    const [draft, setDraft] = useState<SafetyDraft>(stored.draft);
    const [advanced, setAdvanced] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { setDraft(stored.draft); setError(null); }, [stored]);

    // No main agent machine yet: nothing to configure against (the machine group above handles enabling).
    if (!machine) {
        return (
            <ItemGroup settingId="mainAgent.safety" title={copy.title}>
                <Item title={copy.needsMachine} />
            </ItemGroup>
        );
    }
    if (!mainAgentSafetySupported(machine)) {
        return (
            <ItemGroup settingId="mainAgent.safety" title={copy.title}>
                <Item title={copy.presets.strict} subtitle={copy.upgrade} />
            </ItemGroup>
        );
    }

    const policy = draftPolicy(draft);
    const custom = overrideCount(draft);
    const dirty = configStatus === 'ready' && (!sameDraft(draft, stored.draft) || stored.unreadable);
    const set = <K extends keyof MainAgentSafetyPolicy>(key: K, value: MainAgentSafetyPolicy[K]) => setDraft((d) => setDraftItem(d, key, value));

    const onSave = async () => {
        if (!credentials) return;
        setSaving(true);
        setError(null);
        const { configRaw: raw, configVersion: version } = useMainAgentStore.getState();
        const res = await saveMainAgentSafety(credentials, draft, { raw, version });
        setSaving(false);
        if (res.ok) {
            useMainAgentStore.setState({ configRaw: res.raw, config: parseMainAgentConfig(res.raw), configVersion: res.version, configStatus: 'ready' });
            toast.success(copy.saved);
            return;
        }
        setError(res.error === 'owner_only' ? copy.ownerOnly : res.error === 'conflict' ? copy.conflict : copy.failed);
    };

    const toolOptions = (['deny', 'ask', 'allow'] as const).map((v) => ({ value: v, label: copy.toolPolicy[v] }));
    const dispatchOptions = (['ask', 'direct'] as const).map((v) => ({ value: v, label: copy.dispatchPolicy[v] }));
    const disabled = configStatus !== 'ready' || saving;

    return (
        <ItemGroup settingId="mainAgent.safety" title={copy.title} footer={copy.footer}>
            <div className="mas-block">
                {stored.unreadable && <p className="mas-warn">{copy.unreadable}</p>}
                <Segmented<SafetyPreset>
                    label={copy.presetLabel}
                    options={(['strict', 'standard', 'loose'] as const).map((v) => ({ value: v, label: copy.presets[v] }))}
                    value={draft.preset}
                    disabled={disabled}
                    onChange={(v) => setDraft((d) => setDraftPreset(d, v))}
                />
                <p className="mas-hint">{copy.presetHint[draft.preset]}</p>
                <div className="mas-row-actions">
                    {custom > 0 && <span className="mas-custom">{copy.customized(custom)}</span>}
                    {custom > 0 && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setDraft((d) => setDraftPreset(d, d.preset))}>{copy.resetCustom}</Button>}
                    <Button size="sm" variant="ghost" aria-expanded={advanced} aria-controls="mas-advanced" onClick={() => setAdvanced((a) => !a)}>
                        {advanced ? copy.hideAdvanced : copy.advanced}
                    </Button>
                </div>
            </div>

            <CollapsePanel open={advanced} id="mas-advanced">
                <div className="mas-advanced">
                    {TOOL_CLASSES.map((cls) => (
                        <div className="mas-item" key={cls}>
                            <div className="mas-item-label" id={`mas-${cls}`}>{copy.toolClass[cls]}</div>
                            <Segmented<ToolPolicy> labelledBy={`mas-${cls}`} options={toolOptions} value={policy[cls]} disabled={disabled} onChange={(v) => set(cls, v)} />
                            <p className="mas-hint">{copy.toolEffect(cls, policy[cls])}</p>
                        </div>
                    ))}
                    {DISPATCH_KEYS.map((key) => (
                        <div className="mas-item" key={key}>
                            <div className="mas-item-label" id={`mas-${key}`}>{copy.dispatch[key]}</div>
                            <Segmented<DispatchPolicy> labelledBy={`mas-${key}`} options={dispatchOptions} value={policy[key]} disabled={disabled} onChange={(v) => set(key, v)} />
                            <p className="mas-hint">{copy.dispatchEffect(key, policy[key])}</p>
                        </div>
                    ))}
                    <div className="mas-item">
                        <Checkbox checked={policy.bash} disabled={disabled} onCheckedChange={(c) => set('bash', c)}>{copy.bash}</Checkbox>
                        <p className="mas-warn">{copy.bashRisk}</p>
                    </div>
                    <div className="mas-item">
                        <Checkbox checked={policy.fileEdits} disabled={disabled} onCheckedChange={(c) => set('fileEdits', c)}>{copy.fileEdits}</Checkbox>
                        <p className="mas-warn">{copy.fileEditsRisk}</p>
                    </div>
                    <div className="mas-item">
                        <div className="mas-item-label">{copy.allowedTools}</div>
                        {draft.allowedTools.length === 0
                            ? <p className="mas-hint">{copy.allowedToolsEmpty}</p>
                            : (
                                <ul className="mas-tools">
                                    {draft.allowedTools.map((tool) => (
                                        <li key={tool} className="mas-tool">
                                            <span className="mono mas-tool-name">{tool}</span>
                                            <Button size="sm" variant="ghost" aria-label={copy.removeAllowed(tool)} disabled={disabled}
                                                onClick={() => setDraft((d) => ({ ...d, allowedTools: d.allowedTools.filter((t) => t !== tool) }))}>
                                                <X size={14} aria-hidden="true" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        <p className="mas-hint">{copy.allowedToolsHint}</p>
                    </div>
                </div>
            </CollapsePanel>

            <div className="mas-actions">
                {error && <p className="tg-error mas-error" role="alert">{error}</p>}
                <span className="mas-note">{copy.appliesNext}</span>
                <Button variant="primary" loading={saving} disabled={!dirty || disabled} onClick={() => void onSave()}>{copy.save}</Button>
            </div>
        </ItemGroup>
    );
}
