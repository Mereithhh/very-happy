/**
 * ModeMenu — a small labelled dropdown (Radix) used for model / permission /
 * effort selection in the composer status row.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import type { ModeOption } from '@/components/modelModeOptions';
import './modemenu.css';

export function ModeMenu({
    label,
    options,
    value,
    onChange,
}: {
    label: string;
    options: ModeOption[];
    value: string | null;
    onChange: (key: string) => void;
}) {
    if (options.length === 0) return null;
    const current = options.find((o) => o.key === value) ?? options[0];

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button type="button" className="mm-trigger" aria-label={label}>
                    <span className="mm-k">{label}</span>
                    <span className="mm-v">{current?.name ?? value}</span>
                    <ChevronDown size={12} className="mm-caret" />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="mm-content" sideOffset={6} align="start">
                    {options.map((o) => (
                        <DropdownMenu.Item
                            key={o.key}
                            className="mm-item"
                            onSelect={() => onChange(o.key)}
                        >
                            <span className="mm-item-check">{o.key === current?.key && <Check size={13} />}</span>
                            <span className="mm-item-body">
                                <span className="mm-item-name">{o.name}</span>
                                {o.description && <span className="mm-item-desc">{o.description}</span>}
                            </span>
                        </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
