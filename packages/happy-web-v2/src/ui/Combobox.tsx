/**
 * B-714 — choice from a long, dynamic or grouped list: machines, projects,
 * branches, models, checkpoints. A search box appears above 8 options (or with
 * `searchable`); supports groups, disabled rows with a reason, async loading /
 * error + retry, and trailing action rows (「＋ 新建 provider…」).
 * Desktop: popover; phones (coarse, ≤600px): bottom sheet with the search pinned.
 * Behaviour and ARIA live in ui/picker/Picker.tsx.
 */
import { Picker, type PickerProps, type PickerText } from './picker/Picker';
import { pickerText } from './SelectMenu';

export type ComboboxProps<V extends string = string> = Omit<PickerProps<V>, 'text'> & {
    text?: Partial<PickerText>;
};

export function Combobox<V extends string = string>({ text, searchable = 'auto', ...props }: ComboboxProps<V>) {
    return <Picker {...props} searchable={searchable} text={{ ...pickerText(), ...text }} />;
}
