import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import type { ModeOption } from '@/components/modelModeOptions';
import './sessionOptionsDialog.css';

type OptionFieldProps = {
    label: string;
    options: ModeOption[];
    value: string | null;
    onChange: (key: string) => void;
};

function OptionField({ label, options, value, onChange }: OptionFieldProps) {
    if (options.length === 0) return null;
    const selectedValue = options.some((option) => option.key === value)
        ? value ?? options[0].key
        : options[0].key;

    return (
        <label className="so-field">
            <span className="so-field-label">{label}</span>
            <span className="so-select-wrap">
                <select
                    className="so-select"
                    aria-label={label}
                    value={selectedValue}
                    onChange={(event) => onChange(event.target.value)}
                >
                    {options.map((option) => (
                        <option key={option.key} value={option.key}>{option.name}</option>
                    ))}
                </select>
                <ChevronDown size={15} aria-hidden="true" />
            </span>
        </label>
    );
}

export function SessionOptionsDialog({
    open,
    onOpenChange,
    triggerLabel,
    triggerSummary,
    title,
    description,
    closeLabel,
    model,
    permission,
    effort,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    triggerLabel: string;
    triggerSummary: string;
    title: string;
    description: string;
    closeLabel: string;
    model: OptionFieldProps;
    permission: OptionFieldProps;
    effort: OptionFieldProps;
}) {
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Trigger asChild>
                <button type="button" className="so-trigger">
                    <SlidersHorizontal size={15} aria-hidden="true" />
                    <span className="so-trigger-label">{triggerLabel}</span>
                    <span className="so-trigger-summary">{triggerSummary}</span>
                </button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="so-overlay" />
                <Dialog.Content className="so-dialog">
                    <div className="so-head">
                        <div>
                            <Dialog.Title className="so-title">{title}</Dialog.Title>
                            <Dialog.Description className="so-description">{description}</Dialog.Description>
                        </div>
                        <Dialog.Close asChild>
                            <button type="button" className="so-close" aria-label={closeLabel}>
                                <X size={18} />
                            </button>
                        </Dialog.Close>
                    </div>
                    <div className="so-fields">
                        <OptionField {...model} />
                        <OptionField {...permission} />
                        <OptionField {...effort} />
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
