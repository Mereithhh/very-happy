import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight, PenLine, Plus, SlidersHorizontal, Zap } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { EffortEnergy, EffortSegments, isMaximumEffort } from '@/components/EffortSegments';
import type { ModeOption } from '@/components/modelModeOptions';
import { listedModelKey, type ModelPickerLayout } from './modelPickerLayout';
import './modemenu.css';
import './modelEffortMenu.css';
import '@/components/accounts/accounts.css';

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

/** B-893: 「输入模型名」 — `check` returns an error text or the value to pick. */
export type MenuCustomModel = {
    entryLabel: string;
    placeholder: string;
    submitLabel: string;
    hint: string;
    check: (raw: string) => { ok: true; value: string } | { ok: false; error: string };
};

/** B-850c: the 账号 block on top of the panel (rows from sessionAccount.buildAccountSection). */
export type MenuAccountSection = {
    label: string;
    rows: { key: string; name: string; tag?: string; status?: { text: string; tone: string }; disabled?: boolean; action?: MenuAction }[];
    value: string;
    switchable: boolean;
    onChoose: (key: string) => void;
    note?: { text: string; action?: MenuAction };
    add?: MenuAction;
};

/**
 * One composer entry for 「运行配置」: model + that model's thinking stops.
 * B-849a: a flat list (newest per family, then 「更多模型」) instead of a
 * picker inside the popover — on phones it is ONE bottom sheet, never a sheet
 * over a popover. `layout` comes from layoutModelPicker; `readOnly` replaces
 * the model list (Gemini: the machine config decides); `notice` explains an
 * unknown running model; `footer` says the scope and offers the explicit
 * 「设为新会话默认」 (a pick here never writes the account default, B-848).
 */
export function ModelEffortMenu({ label, modelLabel, options, layout, value, onChange, subtitle, notice, readOnly, effort, longContextLabel, longContextHint, longContextLockedHint, moreLabel, footer, customize, onOpen, triggerLabel, account, triggerPrefix, customModel, rowExtra, pickRow, onLongContextToggle }: {
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
    /** B-908: hint under a locked 1M switch (「这个模型默认 1M 上下文」). */
    longContextLockedHint?: string;
    moreLabel?: string;
    footer?: { note: string; action?: MenuAction };
    customize?: MenuAction;
    onOpen?: () => void;
    /** Closed-entry text when it is not the selected option's name (read-only / unknown). */
    triggerLabel?: string;
    account?: MenuAccountSection;
    /** B-850c: the account's name before the model on the closed entry (「组织 A · Opus 5.5」). */
    triggerPrefix?: string;
    customModel?: MenuCustomModel;
    /** B-894b: a link beside one model row (Codex 「更新」 next to its B-893 gate mark). */
    rowExtra?: (option: ModeOption) => ReactNode;
    /** B-908: what a row pick sends (Claude: the 1M twin by default); the 1M switch bypasses it. */
    pickRow?: (key: string) => string;
    /** B-908: the user flipped the 1M switch (remembered as the account's 1M preference). */
    onLongContextToggle?: (on: boolean) => void;
}) {
    const [open, setOpen] = useState(false);
    const sheet = useSheetMode();
    const resolvedLayout = layout ?? { primary: options, more: [], longContext: null, selectedInMore: false };
    const listedKey = listedModelKey(resolvedLayout, value) ?? options[0]?.key ?? null;
    const [moreOpen, setMoreOpen] = useState(resolvedLayout.selectedInMore);
    useEffect(() => { if (open) setMoreOpen(resolvedLayout.selectedInMore); }, [open, resolvedLayout.selectedInMore]);
    if (!options.length && !readOnly) return null;
    // The closed entry names the exact pick (「Opus 5.5 · 1M」); the list checks the row it sits under.
    const current = options.find((option) => option.key === value) ?? options.find((option) => option.key === listedKey) ?? options[0];
    const strength = effort.options.find((option) => option.key === effort.value)?.name;
    const atMax = isMaximumEffort(effort.options, effort.value);
    const choose = (key: string) => { if (key !== value) onChange(key); };
    // A row stands for its model; the pick may be its 1M twin (B-908). Re-picking the checked row is a no-op.
    const chooseRow = (key: string) => { if (key !== listedKey) choose(pickRow ? pickRow(key) : key); };
    const setOpenAndNotify = (next: boolean) => { setOpen(next); if (next) onOpen?.(); };
    const runAction = (action: MenuAction) => { setOpen(false); action.onSelect(); };

    const body = <ModelEffortBody
        modelLabel={modelLabel} layout={resolvedLayout} selectedKey={listedKey} onChoose={chooseRow}
        subtitle={subtitle} notice={notice} readOnly={readOnly} effort={effort}
        longContext={resolvedLayout.longContext && longContextLabel ? { ...resolvedLayout.longContext, label: longContextLabel, hint: resolvedLayout.longContext.locked ? longContextLockedHint ?? longContextHint : longContextHint, onToggle: (on) => { onLongContextToggle?.(on); onChange(on ? resolvedLayout.longContext!.onKey : resolvedLayout.longContext!.offKey); } } : null}
        more={moreLabel ? { label: moreLabel, open: moreOpen, onToggle: () => setMoreOpen((v) => !v) } : null}
        footer={footer} customize={customize} runAction={runAction} account={account} rowExtra={rowExtra}
        customModel={customModel ? { ...customModel, onPick: (key) => { setOpen(false); choose(key); } } : undefined} />;

    const trigger = (
        <button type="button" className="mm-trigger me-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
            onClick={sheet ? () => setOpenAndNotify(!open) : undefined}>
            <Zap size={13} aria-hidden="true" />
            <span className="mm-v">{triggerPrefix ? `${triggerPrefix} · ` : ''}{triggerLabel ?? current?.name}</span>
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

function ModelEffortBody({ modelLabel, layout, selectedKey, onChoose, subtitle, notice, readOnly, effort, longContext, more, footer, customize, runAction, account, customModel, rowExtra }: {
    modelLabel: string;
    layout: ModelPickerLayout;
    selectedKey: string | null;
    onChoose: (key: string) => void;
    subtitle?: string;
    notice?: { text: string; action?: MenuAction; extra?: ReactNode };
    readOnly?: { value: string; hint: string };
    effort: { label: string; options: ModeOption[]; value: string | null; onChange: (key: string) => void };
    longContext: { on: boolean; locked?: boolean; label: string; hint?: string; onToggle: (on: boolean) => void } | null;
    more: { label: string; open: boolean; onToggle: () => void } | null;
    footer?: { note: string; action?: MenuAction };
    customize?: MenuAction;
    runAction: (action: MenuAction) => void;
    account?: MenuAccountSection;
    customModel?: MenuCustomModel & { onPick: (key: string) => void };
    rowExtra?: (option: ModeOption) => ReactNode;
}) {
    const id = useId();
    const accountId = useId();
    const rows = (list: ModeOption[]): ReactNode => list.map((option) => {
        const selected = option.key === selectedKey;
        // B-849a2: a listed entry that would not take effect here says why instead of being picked.
        const disabled = !!option.disabled && !selected;
        const button = <button key={option.key} type="button" role="radio" aria-checked={selected} aria-disabled={disabled || undefined}
            className={`me-model${selected ? ' me-model--on' : ''}${disabled ? ' me-model--off' : ''}`} onClick={disabled ? undefined : () => onChoose(option.key)}>
            <span className="me-model-text">
                <span className="me-model-name">{option.name}</span>
                {option.description && <span className="me-model-desc">{option.description}</span>}
            </span>
            {selected && <Check size={15} className="me-model-check" aria-hidden="true" />}
        </button>;
        // B-894b: the link is a sibling, never nested in the radio (same row shape as the account rows).
        const extra = rowExtra?.(option);
        return extra ? <div key={option.key} className="me-account-row" data-testid="model-row-extra">{button}{extra}</div> : button;
    });
    return <>
        {account && <>
            <span className="me-model-label" id={accountId}>{account.label}</span>
            <div className="me-models me-accounts" role="radiogroup" aria-labelledby={accountId} data-testid="run-setup-accounts">
                {account.rows.map((row) => {
                    const selected = row.key === account.value;
                    const off = (!account.switchable || !!row.disabled) && !selected;
                    return <div key={row.key} className="me-account-row">
                        <button type="button" role="radio" aria-checked={selected} aria-disabled={off || undefined} data-account-key={row.key}
                            className={`me-model${selected ? ' me-model--on' : ''}${off ? ' me-model--off' : ''}`}
                            onClick={off || selected ? undefined : () => runAction({ label: row.name, onSelect: () => account.onChoose(row.key) })}>
                            <span className="me-model-text">
                                <span className="me-model-name">{row.name}{row.tag && <span className="me-account-tag"> · {row.tag}</span>}</span>
                                {row.status && <span className="me-model-desc me-account-status" data-tone={row.status.tone}>{row.status.text}</span>}
                            </span>
                            {selected && <Check size={15} className="me-model-check" aria-hidden="true" />}
                        </button>
                        {row.action && <button type="button" className="me-link" onClick={() => runAction(row.action!)}>{row.action.label}</button>}
                    </div>;
                })}
                {account.add && <button type="button" className="me-more me-account-add" onClick={() => runAction(account.add!)}>
                    <Plus size={14} aria-hidden="true" /><span>{account.add.label}</span>
                </button>}
            </div>
            {account.note && <div className="me-notice" role="status">
                <span>{account.note.text}</span>
                {account.note.action && <button type="button" className="me-link" onClick={() => runAction(account.note!.action!)}>{account.note.action.label}</button>}
            </div>}
        </>}
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
                {customModel && <CustomModelRow {...customModel} />}
            </div>}
        {/* QA26 P2-3: the whole row is the switch — a ≥44px target on phones, not just the 26px track. */}
        {longContext && !readOnly && <button type="button" role="switch" aria-checked={longContext.on} className="me-switch-row"
            aria-disabled={longContext.locked || undefined} data-locked={longContext.locked ? 'true' : undefined}
            onClick={longContext.locked ? undefined : () => longContext.onToggle(!longContext.on)}>
            <span className="me-switch-text"><span>{longContext.label}</span>{longContext.hint && <span className="me-note">{longContext.hint}</span>}</span>
            <span className="me-switch" aria-hidden="true"><span className="me-switch-thumb" /></span>
        </button>}
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

function CustomModelRow({ entryLabel, placeholder, submitLabel, hint, check, onPick }: MenuCustomModel & { onPick: (key: string) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | null>(null);
    const errorId = useId();
    if (!editing) {
        return <button type="button" className="me-more me-custom-entry" onClick={() => setEditing(true)}>
            <PenLine size={14} aria-hidden="true" /><span>{entryLabel}</span>
        </button>;
    }
    const submit = () => {
        const result = check(draft);
        if (!result.ok) { setError(result.error); return; }
        setError(null);
        setDraft('');
        setEditing(false);
        onPick(result.value);
    };
    return <form className="me-custom" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="me-custom-row">
            <input className="me-custom-input" value={draft} autoFocus placeholder={placeholder} aria-label={entryLabel}
                aria-invalid={error ? true : undefined} aria-describedby={errorId}
                autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={200}
                onChange={(event) => { setDraft(event.target.value); if (error) setError(null); }}
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); setError(null); } }} />
            <button type="submit" className="me-custom-use">{submitLabel}</button>
        </div>
        <span id={errorId} className={error ? 'me-note me-custom-error' : 'me-note'} role={error ? 'alert' : undefined}>{error ?? hint}</span>
    </form>;
}
