import type { ModeOption } from '@/components/modelModeOptions';

/** Do not turn a stale model's effort into the new model's first slider stop. */
export function selectDisplayedEffortKey(options: ModeOption[], preferred: Array<string | null | undefined>): string | null {
    for (const key of preferred) {
        if (key != null && options.some((option) => option.key === key)) return key;
    }
    return null;
}
