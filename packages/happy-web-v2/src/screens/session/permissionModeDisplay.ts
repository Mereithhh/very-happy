/**
 * 权限模式选择器的「诚实副文案」七态（B-262 A4，纯函数）。
 *
 * 显示值 = 意图；副文案说明 CLI 是否确认了它。accent 只表示 live，这里一律中性 mono。
 */
import type { IntentSource } from '@/sync/yoloEnforcement';

export type PermissionModeDisplayState =
    | 'confirmed'
    | 'pending'
    | 'conflict'
    | 'startup-yolo'
    | 'unconfirmed-intent'
    | 'unconfirmed-guess'
    | 'unconfirmed-other';

export function derivePermissionModeDisplay(input: {
    displayed: string | null | undefined;
    published: string | null | undefined;
    dangerouslySkipPermissions: boolean | null | undefined;
    intentSource: IntentSource;
    busy: boolean;
}): PermissionModeDisplayState {
    const { displayed, published } = input;
    if (published != null) {
        if (published === displayed) return 'confirmed';
        return input.busy ? 'pending' : 'conflict';
    }
    const wantsBypass = displayed === 'bypassPermissions' || displayed === 'yolo';
    if (!wantsBypass) return input.busy ? 'pending' : 'unconfirmed-other';
    if (input.dangerouslySkipPermissions === true) return 'startup-yolo';
    if (input.intentSource === 'local' || input.intentSource === 'override') return 'unconfirmed-intent';
    return 'unconfirmed-guess';
}
