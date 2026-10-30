import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight, SlidersHorizontal, Zap } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { EffortEnergy, EffortSegments, isMaximumEffort } from '@/components/EffortSegments';
import type { ModeOption } from '@/components/modelModeOptions';
import { listedModelKey, type ModelPickerLayout } from './modelPickerLayout';
import './modemenu.css';
import './modelEffortMenu.css';

/** Same breakpoint as the shared picker's bottom sheet (ui/picker). */
const SHEET_MQ = '(pointer: coarse) and (max-width: 600px)';

function useSheetMode(): boolean {
    const query = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SHEET_MQ).matches;
    const [sheet, setSheet] = useState(query);
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia(SHEET_MQ);
        const update = () => setSheet(mq.matches);
        update();
        mq.addEventListener?.('change', update);
        return () => mq.removeEventListener?.('change', update);
    }, []);
    return sheet;
}

type MenuAction = { label: string; onSelect: () => void };

/**
 * One composer entry for 「运行配置」: model + that model's thinking stops.
 * B-849a: a flat list (newest per family, then 「更多模型」) instead of a
 * picker inside the popover — on phones it is ONE bottom sheet, never a sheet
 * over a popover. `layout` comes from layoutModelPicker; `readOnly` replaces
 * the model list (Gemini: the machine config decides); `notice` explains an
 * unknown running model; `footer` says the scope and offers the explicit
 * 「设为新会话默认」 (a pick here never writes the account default, B-848).
 */
export function ModelEffortMenu({ label, modelLabel, options, layout, value, onChange, subtitle, notice, readOnly, effort, longContextLabel, longContextHint, moreLabel, footer, customize, onOpen, triggerLabel }: {
    label: string;
    modelLabel: string;
    options: ModeOption[];
    layout?: ModelPickerLayout;
    value: string | null;
    onChange: (key: string) => void;
    subtitle?: string;
    notice?: { text: string; action?: MenuAction; extra?: ReactNode };
    readOnly?: { value: string; hint: string };
    effort: { label: string; options: ModeOption[]; value: string | null; onChange: (key: string) => void };
    longContextLabel?: string;
    longContextHint?: string;
    moreLabel?: string;
    footer?: { note: string; action?: MenuAction };
    customize?: MenuAction;
    onOpen?: () => void;
    /** Closed-entry text when it is not the selected option's name (read-only / unknown). */
    triggerLabel?: string;
}) {
    const [open, setOpen] = useState(false);
    const sheet = useSheetMode();
    const resolvedLayout = layout ?? { primary: options, more: [], longContext: null, selectedInMore: false };
    const listedKey = listedModelKey(resolvedLayout, value) ?? options[0]?.key ?? null;
    const [moreOpen, setMoreOpen] = useState(resolvedLayout.selectedInMore);
    useEffect(() => { if (open) setMoreOpen(resolvedLayout.selectedInMore); }, [open, resolvedLayout.selectedInMore]);
    if (!options.length && !readOnly) return null;
    const current = options.find((option) => option.key === listedKey) ?? options[0];
    const strength = effort.options.find((option) => option.key === effort.value)?.name;
    const atMax = isMaximumEffort(effort.options, effort.value);
    const choose = (key: string) => { if (key !== value) onChange(key); };
    const setOpenAndNotify = (next: boolean) => { setOpen(next); if (next) onOpen?.(); };
    const runAction = (action: MenuAction) => { setOpen(false); action.onSelect(); };

    const body = <ModelEffortBody
        modelLabel={modelLabel} layout={resolvedLayout} selectedKey={listedKey} onChoose={choose}
        subtitle={subtitle} notice={notice} readOnly={readOnly} effort={effort}
        longContext={resolvedLayout.longContext && longContextLabel ? { ...resolvedLayout.longContext, label: longContextLabel, hint: longContextHint, onToggle: (on) => onChange(on ? resolvedLayout.longContext!.onKey : resolvedLayout.longContext!.offKey) } : null}
        more={moreLabel ? { label: moreLabel, open: moreOpen, onToggle: () => setMoreOpen((v) => !v) } : null}
        footer={footer} customize={customize} runAction={runAction} />;

    const trigger = (
        <button type="button" className="mm-trigger me-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
            onClick={sheet ? () => setOpenAndNotify(!open) : undefined}>
            <Zap size={13} aria-hidden="true" />
            <span className="mm-v">{triggerLabel ?? current?.name}</span>
            {strength && <span className={`me-strength${atMax ? ' me-strength--max' : ''}`}><span>{strength}</span>{atMax && <EffortEnergy />}</span>}
            <ChevronDown size={12} className="mm-caret" aria-hidden="true" />
        </button>
    );

    if (sheet) {
        return <>
            {trigger}
            <Dialog.Root open={open} onOpenChange={setOpenAndNotify}>
                <Dialog.Portal>
                    <Dialog.Overlay className="vh-picker-scrim" />
                    <Dialog.Content className="vh-picker-sheet me-sheet" aria-describedby={undefined}>
                        <div className="vh-picker-sheet-head">
                            <span className="vh-picker-grab" aria-hidden="true" />
                            <Dialog.Title className="vh-picker-sheet-title">{label}</Dialog.Title>
                        </div>
                        <div className="me-sheet-body">{body}</div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </>;
    }
    return <Popover.Root open={open} onOpenChange={setOpenAndNotify}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        <Popover.Portal>
            <Popover.Content className="me-panel" side="top" sideOffset={8} align="start" collisionPadding={12} aria-label={label}>
                <span className="me-title">{label}</span>
                {body}
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>;
}

function ModelEffortBody({ modelLabel, layout, selectedKey, onChoose, subtitle, notice, readOnly, effort, longContext, more, footer, customize, runAction }: {
    modelLabel: string;
    layout: ModelPickerLayout;
    selectedKey: string | null;
    onChoose: (key: string) => void;
    subtitle?: string;
    notice?: { text: string; action?: MenuAction; extra?: ReactNode };
    readOnly?: { value: string; hint: string };
    effort: { label: string; options: ModeOption[]; value: string | null; onChange: (key: string) => void };
    longContext: { on: boolean; label: string; hint?: string; onToggle: (on: boolean) => void } | null;
    more: { label: string; open: boolean; onToggle: () => void } | null;
    footer?: { note: string; action?: MenuAction };
    customize?: MenuAction;
    runAction: (action: MenuAction) => void;
}) {
    const id = useId();
    const rows = (list: ModeOption[]): ReactNode => list.map((option) => {
        const selected = option.key === selectedKey;
        // B-849a2: a listed entry that would not take effect here says why instead of being picked.
        const disabled = !!option.disabled && !selected;
        return <button key={option.key} type="button" role="radio" aria-checked={selected} aria-disabled={disabled || undefined}
            className={`me-model${selected ? ' me-model--on' : ''}${disabled ? ' me-model--off' : ''}`} onClick={disabled ? undefined : () => onChoose(option.key)}>
            <span className="me-model-text">
                <span className="me-model-name">{option.name}</span>
                {option.description && <span className="me-model-desc">{option.description}</span>}
            </span>
            {selected && <Check size={15} className="me-model-check" aria-hidden="true" />}
        </button>;
    });
    return <>
        <span className="me-model-label" id={id}>{modelLabel}</span>
        {readOnly
            ? <div className="me-readonly"><span className="me-readonly-value">{readOnly.value}</span><span className="me-note">{readOnly.hint}</span></div>
            : <div className="me-models" role="radiogroup" aria-labelledby={id}>
                {rows(layout.primary)}
                {more && layout.more.length > 0 && <>
                    <button type="button" className="me-more" aria-expanded={more.open} onClick={more.onToggle}>
                        <ChevronRight size={14} className="me-more-caret" aria-hidden="true" />
                        <span>{more.label}</span>
                        <span className="me-more-count">{layout.more.length}</span>
                    </button>
                    {more.open && <div className="me-more-list">{rows(layout.more)}</div>}
                </>}
                {!more && rows(layout.more)}
            </div>}
        {longContext && !readOnly && <div className="me-switch-row">
            <span className="me-switch-text"><span>{longContext.label}</span>{longContext.hint && <span className="me-note">{longContext.hint}</span>}</span>
            <button type="button" role="switch" aria-checked={longContext.on} className="me-switch" aria-label={longContext.label}
                onClick={() => longContext.onToggle(!longContext.on)}><span className="me-switch-thumb" /></button>
        </div>}
        {subtitle && <p className="me-note">{subtitle}</p>}
        {notice && <div className="me-notice" role="status">
            <span>{notice.text}</span>
            {notice.action && <button type="button" className="me-link" onClick={() => runAction(notice.action!)}>{notice.action.label}</button>}
            {notice.extra}
        </div>}
        <EffortSegments {...effort} />
        {customize && <button type="button" className="me-customize" onClick={() => runAction(customize)}>
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span>{customize.label}</span>
        </button>}
        {footer && <div className="me-footer">
            <span>{footer.note}</span>
            {footer.action && <button type="button" className="me-link" onClick={() => runAction(footer.action!)}>{footer.action.label}</button>}
        </div>}
    </>;
}
