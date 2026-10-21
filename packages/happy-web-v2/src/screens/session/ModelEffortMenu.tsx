import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, SlidersHorizontal, Zap } from 'lucide-react';
import { useId, useState } from 'react';
import { EffortEnergy, EffortSlider, isMaximumEffort } from '@/components/EffortSlider';
import type { ModeOption } from '@/components/modelModeOptions';
import { Combobox } from '@/ui/Combobox';
import './modemenu.css';
import './modelEffortMenu.css';

/**
 * One composer entry owns model selection and that model's exact effort stops.
 * B-688: `customize` adds 「自定义…」 at the bottom (opens the model/provider
 * editor); `onOpen` lets the caller refresh the machine's custom models.
 */
export function ModelEffortMenu({ label, options, value, onChange, subtitle, effort, customize, onOpen, groups }: {
    label: string;
    options: ModeOption[];
    value: string | null;
    onChange: (key: string) => void;
    subtitle?: string;
    effort: { label: string; options: ModeOption[]; value: string | null; onChange: (key: string) => void };
    customize?: { label: string; onSelect: () => void };
    onOpen?: () => void;
    /** B-714: with custom models present, split the list 「默认 · 目录 · 自定义」 */
    groups?: { catalog: string; custom: string; customKeys: readonly string[] };
}) {
    const id = useId();
    const [open, setOpen] = useState(false);
    if (!options.length) return null;
    const current = options.find(option => option.key === value) ?? options[0];
    const strength = effort.options.find(option => option.key === effort.value)?.name;
    const atMax = isMaximumEffort(effort.options, effort.value);
    return <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) onOpen?.(); }}>
        <Popover.Trigger asChild>
            <button type="button" className="mm-trigger me-trigger" aria-label={label}>
                <Zap size={13} aria-hidden="true" />
                <span className="mm-v">{current.name}</span>
                {strength && <span className={`me-strength${atMax ? ' me-strength--max' : ''}`}><span>{strength}</span>{atMax && <EffortEnergy />}</span>}
                <ChevronDown size={12} className="mm-caret" aria-hidden="true" />
            </button>
        </Popover.Trigger>
        <Popover.Portal>
            <Popover.Content className="me-panel" side="top" sideOffset={8} align="start" collisionPadding={12} aria-label={label}>
                <span className="me-model-label" id={id}>{label}</span>
                {/* B-714: the picker portals its own layer; Radix keeps the panel open (React-tree pointer/focus capture). */}
                <Combobox label={label} labelledBy={id} size="md" className="me-model-picker"
                    value={current.key} onChange={onChange}
                    options={options.map(option => ({ value: option.key, label: option.name, description: option.description ?? undefined, group: modelGroup(option.key, groups) }))} />
                {subtitle && <p className="me-note">{subtitle}</p>}
                <EffortSlider {...effort} />
                {customize && <button type="button" className="me-customize" onClick={() => { setOpen(false); customize.onSelect(); }}>
                    <SlidersHorizontal size={14} aria-hidden="true" />
                    <span>{customize.label}</span>
                </button>}
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>;
}

function modelGroup(key: string, groups: { catalog: string; custom: string; customKeys: readonly string[] } | undefined): string | undefined {
    if (!groups || groups.customKeys.length === 0 || key === 'default') return undefined;
    return groups.customKeys.includes(key) ? groups.custom : groups.catalog;
}
