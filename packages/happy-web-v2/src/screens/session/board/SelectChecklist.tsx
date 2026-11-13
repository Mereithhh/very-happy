/**
 * B-924 — the checklist a `decision` card may carry (`payload.type: 'select'`,
 * e.g. the main agent's 收尾建议 card). While the card is open the owner ticks
 * items (owner-respond `check`), then picks an option as usual; once it is
 * closed the list shows, read-only, what was ticked.
 */
import { parseSelectPayload, type AttentionItem } from '@slopus/happy-wire';
import { Checkbox } from '@/ui';
import type { BoardCopy } from './boardCopy';
import { checkSelectItem } from './boardActions';

export function SelectChecklist({ item, copy }: { item: AttentionItem; copy: BoardCopy }) {
    const payload = item.kind === 'decision' ? parseSelectPayload(item.payload) : null;
    if (!payload || payload.items.length === 0) return null;
    // The server accepts a check only while the card is open.
    const editable = item.state === 'open';
    const checked = payload.items.filter((x) => x.checked).length;
    return (
        <div className={`wrp-sec sel${editable ? '' : ' is-readonly'}`}>
            <div className="wrp-label">{editable ? copy.select.title : copy.select.result(checked, payload.items.length)}</div>
            <div className="wrp-checks">
                {payload.items.map((x) => (
                    <Checkbox key={x.id} className="wrp-check sel-check" checked={x.checked} disabled={!editable}
                        onCheckedChange={(next) => void checkSelectItem(item, x.id, next, copy)}>
                        <span className="sel-text">
                            <span>{x.label}</span>
                            {x.detail && <span className="sel-detail">{x.detail}</span>}
                        </span>
                    </Checkbox>
                ))}
            </div>
        </div>
    );
}
