/**
 * B-688: JSON config edits. Claude Code's settings.json and pi's models.json /
 * settings.json are strict JSON, so parse → mutate → stringify keeps every key
 * we don't own and its order (JS objects keep insertion order); indentation and
 * the trailing newline are detected from the original. A file that is not
 * strict JSON (comments, trailing commas) is refused rather than "repaired" —
 * rewriting it would silently drop the user's comments.
 */
import { ModelConfigError } from './fileStore';

export type JsonObject = Record<string, unknown>;

export function parseJsonObject(text: string, label: string): JsonObject {
    if (text.trim() === '') return {};
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        const hasComments = /^\s*\/\/|\/\*/m.test(text);
        throw new ModelConfigError(hasComments ? 'json-has-comments' : 'invalid-json',
            hasComments
                ? `${label} contains comments; Very Happy only edits strict JSON so it never drops them. Edit it by hand or remove the comments.`
                : `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ModelConfigError('invalid-json', `${label} must contain a JSON object`);
    }
    return value as JsonObject;
}

export function detectIndent(text: string): string | number {
    const m = /^([ \t]+)"/m.exec(text);
    return m ? m[1] : 2;
}

export function stringifyLike(original: string, value: JsonObject): string {
    // A one-line (minified) file stays one line, so the diff shows only what changed.
    const compact = original.trim() !== '' && !original.trim().includes('\n');
    const body = compact ? JSON.stringify(value) : JSON.stringify(value, null, detectIndent(original));
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const withEol = eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
    return original === '' || /\r?\n$/.test(original) ? withEol + eol : withEol;
}

/** Set (or delete, for undefined/null) `obj[key]`, creating nothing when deleting. */
export function setOrDelete(obj: JsonObject, key: string, value: unknown): void {
    if (value === undefined || value === null || value === '') delete obj[key];
    else obj[key] = value;
}

/** Child object at `key`, created when missing; refuses a non-object value there. */
export function childObject(obj: JsonObject, key: string, label: string): JsonObject {
    const current = obj[key];
    if (current === undefined) {
        const created: JsonObject = {};
        obj[key] = created;
        return created;
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new ModelConfigError('unexpected-shape', `${label}.${key} is not an object; refusing to overwrite it`);
    }
    return current as JsonObject;
}
