/**
 * B-698 shared 「成员 harness + 默认模型」 fields for the new-team form and team
 * settings. Controlled: the parent owns `assistant` / `model`; switching the
 * harness clears the model (a Claude alias is meaningless to Codex).
 */
import { useEffect, useId, useMemo } from 'react';
import { getHardcodedModelModes } from '@/components/modelModeOptions';
import { collectPiModelOptions } from '@/sync/piModelOptions';
import { useAllSessions, useMachine } from '@/sync/storage';
import { modelConfigStore, useCustomPickerModels } from '@/sync/modelConfigStore';
import { machineSupportsModelConfig } from '@/sync/modelConfigModel';
import { isMachineOnline } from '@/utils/machineUtils';
import { useFirstUseCopy } from './firstUseCopy';
import { Combobox } from '@/ui/Combobox';
import { Segmented } from '@/ui/Segmented';
import { teamAssistantAgent, teamAssistantHarness, teamHarnessChoices, teamModelChoices, type ModelChoice, type TeamAssistant } from './teamHarnessModel';

export function TeamHarnessModelFields({ machineId, assistant, model, onAssistant, onModel, harnessLabel, disabled }: {
    machineId: string;
    assistant: TeamAssistant;
    model: string;
    onAssistant: (assistant: TeamAssistant) => void;
    onModel: (model: string) => void;
    harnessLabel: string;
    disabled?: boolean;
}) {
    const c = useFirstUseCopy();
    const id = useId();
    const machine = useMachine(machineId);
    const sessions = useAllSessions();
    const harness = teamAssistantHarness(assistant);
    const custom = useCustomPickerModels(machineId, harness);
    useEffect(() => {
        if (machine && isMachineOnline(machine) && machineSupportsModelConfig(machine)) void modelConfigStore.getState().load(machineId);
    }, [machineId, machine?.active, machine?.metadata?.modelConfigVersion]);
    const harnesses = teamHarnessChoices(machine?.metadata, assistant);
    const catalog = useMemo(() => {
        const agent = teamAssistantAgent(assistant);
        return agent === 'pi' ? collectPiModelOptions(sessions) : getHardcodedModelModes(agent, (key) => key);
    }, [assistant, sessions]);
    const { choices, savedMissing } = teamModelChoices({ catalog, custom, saved: model, labels: { followDefault: c.modelDefault, custom: c.modelCustom, missing: c.modelNotListed } });
    const current = harnesses.find((h) => h.value === assistant);
    // default + catalog lead ungrouped; custom / missing rows sit under their own heading instead of a label suffix
    const groupLabel: Record<ModelChoice['kind'], string | undefined> = { default: undefined, catalog: undefined, custom: c.modelCustom, missing: c.modelNotListed };
    return <>
        <div className="teams-field">
            <span id={`${id}-harness`}>{harnessLabel}</span>
            <Segmented labelledBy={`${id}-harness`} name="assistant" value={assistant} disabled={disabled}
                options={harnesses.map((h) => ({ value: h.value, label: h.available ? h.label : `${h.label} · ${c.harnessUnavailable}` }))}
                onChange={(next) => { onAssistant(next); onModel(''); }} />
            {current && !current.available && <span className="team-field-warn" role="status">{c.harnessUnavailableHint}</span>}
        </div>
        <div className="teams-field">
            <span id={`${id}-model`}>{c.model}</span>
            <Combobox variant="soft" size="md" label={c.model} labelledBy={`${id}-model`} name="model" value={model} disabled={disabled}
                options={choices.map((m) => ({ value: m.value, label: groupLabel[m.kind] ? m.value : m.label, group: groupLabel[m.kind] }))}
                onChange={onModel} />
            {savedMissing && <span className="team-field-warn" role="status">{c.modelNotListedHint}</span>}
        </div>
    </>;
}
