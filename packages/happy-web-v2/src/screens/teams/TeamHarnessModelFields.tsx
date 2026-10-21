/**
 * B-698 shared 「成员 harness + 默认模型」 fields for the new-team form and team
 * settings. Controlled: the parent owns `assistant` / `model`; switching the
 * harness clears the model (a Claude alias is meaningless to Codex).
 */
import { useEffect, useMemo } from 'react';
import { getHardcodedModelModes } from '@/components/modelModeOptions';
import { collectPiModelOptions } from '@/sync/piModelOptions';
import { useAllSessions, useMachine } from '@/sync/storage';
import { modelConfigStore, useCustomPickerModels } from '@/sync/modelConfigStore';
import { machineSupportsModelConfig } from '@/sync/modelConfigModel';
import { isMachineOnline } from '@/utils/machineUtils';
import { useFirstUseCopy } from './firstUseCopy';
import { teamAssistantAgent, teamAssistantHarness, teamHarnessChoices, teamModelChoices, type TeamAssistant } from './teamHarnessModel';

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
    return <>
        <label>{harnessLabel}<select name="assistant" value={assistant} disabled={disabled} onChange={(e) => { onAssistant(e.target.value as TeamAssistant); onModel(''); }}>
            {harnesses.map((h) => <option key={h.value} value={h.value}>{h.available ? h.label : `${h.label} · ${c.harnessUnavailable}`}</option>)}
        </select>
            {current && !current.available && <span className="team-field-warn" role="status">{c.harnessUnavailableHint}</span>}
        </label>
        <label>{c.model}<select name="model" value={model} disabled={disabled} onChange={(e) => onModel(e.target.value)}>
            {choices.map((m) => <option key={`${m.kind}:${m.value}`} value={m.value}>{m.label}</option>)}
        </select>
            {savedMissing && <span className="team-field-warn" role="status">{c.modelNotListedHint}</span>}
        </label>
    </>;
}
