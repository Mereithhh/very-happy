/**
 * B-714 — single choice from a known, short list (≤12 options, no search).
 * Desktop: popover under the trigger; phones (coarse, ≤600px): bottom sheet.
 * 2–4 options that fit on one line → `.vh-segmented` instead.
 * Behaviour and ARIA live in ui/picker/Picker.tsx.
 */
import { t } from '@/text';
import { Picker, type PickerProps, type PickerText } from './picker/Picker';

export type { PickerOption as SelectOption, PickerAction as SelectAction } from './picker/Picker';

export function pickerText(): PickerText {
    return {
        search: t('picker.search'),
        empty: t('picker.empty'),
        loading: t('picker.loading'),
        retry: t('picker.retry'),
        required: t('picker.required'),
    };
}

export type SelectMenuProps<V extends string = string> = Omit<PickerProps<V>, 'text' | 'searchable' | 'loading' | 'error' | 'onRetry'> & {
    text?: Partial<PickerText>;
};

export function SelectMenu<V extends string = string>({ text, ...props }: SelectMenuProps<V>) {
    return <Picker {...props} searchable={false} text={{ ...pickerText(), ...text }} />;
}
