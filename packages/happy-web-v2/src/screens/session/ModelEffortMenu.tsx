import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Zap } from 'lucide-react';
import { useId } from 'react';
import { EffortEnergy, EffortSlider, isMaximumEffort } from '@/components/EffortSlider';
import type { ModeOption } from '@/components/modelModeOptions';
import './modemenu.css';
import './modelEffortMenu.css';

/** One composer entry owns model selection and that model's exact effort stops. */
export function ModelEffortMenu({ label, options, value, onChange, subtitle, effort }: {
    label: string;
    options: ModeOption[];
    value: string | null;
    onChange: (key: string) => void;
    subtitle?: string;
    effort: { label: string; options: ModeOption[]; value: string | null; onChange: (key: string) => void };
}) {
    const id = useId();
    if (!options.length) return null;
    const current = options.find(option => option.key === value) ?? options[0];
    const strength = effort.options.find(option => option.key === effort.value)?.name;
    const atMax = isMaximumEffort(effort.options, effort.value);
    return <Popover.Root>
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
                <label className="me-model-label" htmlFor={id}>{label}</label>
                <div className="me-model-select">
                    <select id={id} aria-label={label} value={current.key} onChange={event => onChange(event.target.value)}>
                        {options.map(option => <option key={option.key} value={option.key}>{option.name}</option>)}
                    </select>
                    <ChevronDown size={15} aria-hidden="true" />
                </div>
                {subtitle && <p className="me-note">{subtitle}</p>}
                <EffortSlider {...effort} />
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>;
}
