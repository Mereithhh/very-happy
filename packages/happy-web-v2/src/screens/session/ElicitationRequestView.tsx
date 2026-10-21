import { FormEvent, useId, useMemo, useState } from 'react';
import { Button } from '@/ui';
import { Checkbox } from '@/ui/Checkbox';
import { Combobox } from '@/ui/Combobox';
import { Segmented } from '@/ui/Segmented';
import { SelectMenu } from '@/ui/SelectMenu';
import { t } from '@/text';

type JsonSchemaProperty = {
    type?: string;
    title?: string;
    description?: string;
    enum?: unknown[];
    default?: unknown;
    items?: { type?: string };
};

type ElicitationRequest = {
    message?: string;
    mode?: 'form' | 'url';
    url?: string;
    requestedSchema?: {
        properties?: Record<string, JsonSchemaProperty>;
        required?: string[];
    };
};

type EnumValue = string | number | boolean;

/** MCP enum: ≤4 short options → segmented, ≤12 → menu, more → searchable combobox. The value is the option's index; only scalar entries are selectable. */
function EnumField({ label, options, value, disabled, required, missing, labelledBy, onChange }: {
    /** field title: the menu's sheet title */
    label: string;
    options: unknown[];
    value: unknown;
    disabled: boolean;
    required: boolean;
    /** a required enum left empty on submit */
    missing: boolean;
    labelledBy: string;
    onChange: (value: EnumValue | undefined) => void;
}) {
    const index = options.findIndex((option) => Object.is(option, value));
    const choices = options.map((option, i) => ({ value: String(i), label: String(option) }));
    const pick = (next: string) => {
        if (next === '') { onChange(undefined); return; }
        const picked = options[Number(next)];
        if (typeof picked === 'string' || typeof picked === 'number' || typeof picked === 'boolean') onChange(picked);
    };
    if (choices.length <= 4 && choices.every((choice) => choice.label.length <= 24)) {
        return <>
            <Segmented labelledBy={labelledBy} options={choices} value={index < 0 ? '' : String(index)} onChange={pick} disabled={disabled} className="perm-elicitation-segmented" />
            {missing && <span className="tg-error" role="alert">{t('picker.required')}</span>}
        </>;
    }
    const menu = {
        label, labelledBy, placeholder: '—', variant: 'soft', size: 'md', disabled, required, onChange: pick,
        value: index < 0 ? '' : String(index),
        options: required ? choices : [{ value: '', label: '—' }, ...choices],
    } as const;
    return choices.length > 12 ? <Combobox {...menu} /> : <SelectMenu {...menu} />;
}

function safeUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

export function ElicitationRequestView({
    request,
    disabled,
    submitLabel,
    onSubmit,
}: {
    request: ElicitationRequest;
    disabled: boolean;
    submitLabel: string;
    onSubmit: (content: Record<string, string | number | boolean | string[]>) => void;
}) {
    const properties = useMemo(() => Object.entries(request.requestedSchema?.properties ?? {}).slice(0, 50), [request]);
    const required = useMemo(() => new Set(request.requestedSchema?.required ?? []), [request]);
    const [values, setValues] = useState<Record<string, string | number | boolean | string[]>>(() => {
        const initial: Record<string, string | number | boolean | string[]> = {};
        for (const [name, property] of properties) {
            if (typeof property.default === 'string' || typeof property.default === 'number' || typeof property.default === 'boolean') {
                initial[name] = property.default;
            }
        }
        return initial;
    });

    const [attempted, setAttempted] = useState(false);
    const formId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

    const url = safeUrl(request.url);
    if (request.mode === 'url') {
        return (
            <div className="perm-elicitation">
                {request.message && <p>{request.message}</p>}
                {url && <a href={url} target="_blank" rel="noreferrer">{url}</a>}
                <Button size="sm" variant="primary" disabled={disabled || !url} onClick={() => onSubmit({})}>
                    {submitLabel}
                </Button>
            </div>
        );
    }

    const submit = (event: FormEvent) => {
        event.preventDefault();
        setAttempted(true);
        for (const name of required) {
            const value = values[name];
            if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
                || (typeof value === 'number' && !Number.isFinite(value))) return;
        }
        onSubmit(values);
    };

    return (
        <form className="perm-elicitation" onSubmit={submit}>
            {request.message && <p>{request.message}</p>}
            {properties.map(([name, property], fieldIndex) => {
                const title = <span id={`${formId}-${fieldIndex}`}>{String(property.title || name).slice(0, 120)}{required.has(name) ? ' *' : ''}</span>;
                const description = property.description && <small>{property.description.slice(0, 400)}</small>;
                // B-714: picker / segmented / checkbox are buttons or own a <label> — a wrapping <label> would re-target clicks.
                if (Array.isArray(property.enum) || property.type === 'boolean') {
                    return (
                        <div key={name} className="perm-elicitation-field">
                            {title}
                            {Array.isArray(property.enum)
                                ? <EnumField label={String(property.title || name).slice(0, 120)} options={property.enum} value={values[name]} disabled={disabled}
                                    required={required.has(name)} missing={attempted && required.has(name) && values[name] === undefined}
                                    labelledBy={`${formId}-${fieldIndex}`}
                                    onChange={(value) => setValues((old) => {
                                        const next = { ...old };
                                        if (value === undefined) delete next[name];
                                        else next[name] = value;
                                        return next;
                                    })} />
                                : <Checkbox disabled={disabled} checked={values[name] === true} aria-labelledby={`${formId}-${fieldIndex}`}
                                    onCheckedChange={(checked) => setValues((old) => ({ ...old, [name]: checked }))} />}
                            {description}
                        </div>
                    );
                }
                return (
                    <label key={name}>
                        {title}
                        {property.type === 'array' && property.items?.type === 'string' ? (
                            <input disabled={disabled} required={required.has(name)} maxLength={4096} type="text" value={Array.isArray(values[name]) ? values[name].join(', ') : ''} onChange={(event) => setValues((old) => ({ ...old, [name]: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) }))} />
                        ) : (
                            <input disabled={disabled} required={required.has(name)} maxLength={4096} step={property.type === 'integer' ? 1 : undefined} type={property.type === 'number' || property.type === 'integer' ? 'number' : 'text'} value={String(values[name] ?? '')} onChange={(event) => setValues((old) => ({ ...old, [name]: property.type === 'number' || property.type === 'integer' ? (event.target.value === '' ? '' : event.target.valueAsNumber) : event.target.value }))} />
                        )}
                        {description}
                    </label>
                );
            })}
            <Button size="sm" variant="primary" disabled={disabled} type="submit">{submitLabel}</Button>
        </form>
    );
}
