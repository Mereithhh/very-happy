/**
 * B-698 team harness + default-model choices (pure). The team settings and the
 * new-team form offer only the harnesses the team's machine can run, and a
 * model SELECT built from that harness's catalog on the machine — the bundled
 * list (claude/codex), the models pi sessions on the account published (pi),
 * plus the machine's custom models from its harness config (B-688). '' means
 * "follow the harness default" (no model sent). A saved value outside the list
 * stays selectable and is flagged instead of being silently dropped.
 */
import type { ModeOption } from '@/components/modelModeOptions';
import type { MachineMetadata } from '@/sync/storageTypes';
import type { HarnessId } from '@/sync/modelConfigTypes';
import { resolveAgentAvailability } from '@/utils/agentAvailability';

export type TeamAssistant = 'claude' | 'codex' | 'pi-acp';
/** The harnesses the Teams protocol can launch (TeamAssistantSchema). Gemini is not one of them. */
export const TEAM_ASSISTANTS: readonly TeamAssistant[] = ['claude', 'codex', 'pi-acp'];
export const TEAM_ASSISTANT_LABELS: Record<TeamAssistant, string> = { claude: 'Claude Code', codex: 'Codex', 'pi-acp': 'pi' };

export function teamAssistantAgent(assistant: TeamAssistant): 'claude' | 'codex' | 'pi' {
    return assistant === 'pi-acp' ? 'pi' : assistant;
}

export function teamAssistantHarness(assistant: TeamAssistant): HarnessId {
    return teamAssistantAgent(assistant);
}

export interface HarnessChoice { value: TeamAssistant; label: string; available: boolean }

/** Available harnesses on the machine; the current value stays listed (flagged) even when it is not. */
export function teamHarnessChoices(metadata: MachineMetadata | null | undefined, current: TeamAssistant | null | undefined): HarnessChoice[] {
    return TEAM_ASSISTANTS
        .map((value) => ({ value, label: TEAM_ASSISTANT_LABELS[value], available: resolveAgentAvailability(metadata, teamAssistantAgent(value)).available }))
        .filter((choice) => choice.available || choice.value === current);
}

/** First available harness, for a machine that cannot run the preferred one. */
export function preferredTeamAssistant(metadata: MachineMetadata | null | undefined, preferred: TeamAssistant): TeamAssistant {
    const choices = teamHarnessChoices(metadata, null);
    return choices.some((c) => c.value === preferred) ? preferred : choices[0]?.value ?? 'claude';
}

export interface ModelChoice { value: string; label: string; kind: 'default' | 'catalog' | 'custom' | 'missing' }

export function teamModelChoices(input: {
    catalog: readonly ModeOption[];
    custom: readonly string[];
    saved: string | null | undefined;
    labels: { followDefault: string; custom: string; missing: string };
}): { choices: ModelChoice[]; savedMissing: boolean } {
    const choices: ModelChoice[] = [{ value: '', label: input.labels.followDefault, kind: 'default' }];
    const seen = new Set<string>(['', 'default']);
    for (const option of input.catalog) {
        if (seen.has(option.key)) continue;
        seen.add(option.key);
        choices.push({ value: option.key, label: option.name === option.key ? option.key : `${option.name} · ${option.key}`, kind: 'catalog' });
    }
    for (const id of input.custom) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        choices.push({ value: id, label: `${id} · ${input.labels.custom}`, kind: 'custom' });
    }
    const saved = input.saved?.trim() ?? '';
    const savedMissing = !!saved && !seen.has(saved);
    if (savedMissing) choices.push({ value: saved, label: `${saved} · ${input.labels.missing}`, kind: 'missing' });
    return { choices, savedMissing };
}
