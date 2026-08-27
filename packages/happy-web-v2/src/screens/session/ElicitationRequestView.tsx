import { FormEvent, useMemo, useState } from 'react';
import { Button } from '@/ui';

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
            {properties.map(([name, property]) => (
                <label key={name}>
                    <span>{String(property.title || name).slice(0, 120)}{required.has(name) ? ' *' : ''}</span>
                    {Array.isArray(property.enum) ? (
                        <select disabled={disabled} required={required.has(name)} value={property.enum.findIndex((option) => Object.is(option, values[name])) < 0 ? '' : String(property.enum.findIndex((option) => Object.is(option, values[name])))} onChange={(event) => {
                            if (event.target.value === '') {
                                setValues((old) => {
                                    const next = { ...old };
                                    delete next[name];
                                    return next;
                                });
                                return;
                            }
                            const index = Number(event.target.value);
                            const value = property.enum?.[index];
                            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                                setValues((old) => ({ ...old, [name]: value }));
                            }
                        }}>
                            <option value="" />
                            {property.enum.map((option, index) => <option key={`${index}:${String(option)}`} value={index}>{String(option)}</option>)}
                        </select>
                    ) : property.type === 'boolean' ? (
                        <input disabled={disabled} type="checkbox" checked={values[name] === true} onChange={(event) => setValues((old) => ({ ...old, [name]: event.target.checked }))} />
                    ) : property.type === 'array' && property.items?.type === 'string' ? (
                        <input disabled={disabled} required={required.has(name)} maxLength={4096} type="text" value={Array.isArray(values[name]) ? values[name].join(', ') : ''} onChange={(event) => setValues((old) => ({ ...old, [name]: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) }))} />
                    ) : (
                        <input disabled={disabled} required={required.has(name)} maxLength={4096} step={property.type === 'integer' ? 1 : undefined} type={property.type === 'number' || property.type === 'integer' ? 'number' : 'text'} value={String(values[name] ?? '')} onChange={(event) => setValues((old) => ({ ...old, [name]: property.type === 'number' || property.type === 'integer' ? (event.target.value === '' ? '' : event.target.valueAsNumber) : event.target.value }))} />
                    )}
                    {property.description && <small>{property.description.slice(0, 400)}</small>}
                </label>
            ))}
            <Button size="sm" variant="primary" disabled={disabled} type="submit">{submitLabel}</Button>
        </form>
    );
}
